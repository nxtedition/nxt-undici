/* eslint-disable */
// Regression tests for the 2026-07 cache deep-review fixes (read-path guards
// and the user-supplied CacheStore contract seam):
// - if-match / if-unmodified-since / if-range requests bypass BEFORE the
//   store lookup (the synchronous get was paid and then discarded).
// - a fresh 206 entry from a range-unaware store must not be served to a
//   request without a Range header.
// - an entry past deleteAt from a non-filtering store must be treated as a
//   miss (the read path previously trusted retention expiry to the store).
// - an async store (Promise-returning get/set/delete) must degrade to a
//   logged miss instead of: treating the Promise as an entry, sending
//   `if-modified-since: Invalid Date` to the origin, and crashing the
//   process on a rejected promise (unhandledRejection).
// - a store that round-trips set() values verbatim (body as Buffer[]) must
//   not silently serve empty bodies: the read path normalizes chunk arrays.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose } from '../lib/index.js'
import undici from '@nxtedition/undici'

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.cache())
}

function rawRequest(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    let headers
    const chunks = []
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc, h) {
        statusCode = sc
        headers = h
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        return true
      },
      onComplete() {
        resolve({ statusCode, headers, body: Buffer.concat(chunks).toString() })
      },
      onError: reject,
    })
  })
}

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

function origin(server) {
  return `http://0.0.0.0:${server.address().port}`
}

function freshEntry(body = 'cached-body', overrides = {}) {
  const now = Date.now()
  const buf = Buffer.from(body)
  return {
    body: buf,
    statusCode: 200,
    statusMessage: 'OK',
    headers: { 'cache-control': 'max-age=60' },
    cacheControlDirectives: { 'max-age': 60 },
    etag: undefined,
    vary: undefined,
    cachedAt: now,
    staleAt: now + 60e3,
    deleteAt: now + 120e3,
    ...overrides,
  }
}

test('if-match/if-unmodified-since/if-range bypass without paying the store lookup', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {})
    res.end('origin-body')
  })
  t.teardown(() => server.close())

  let gets = 0
  const store = {
    get() {
      gets++
      return undefined
    },
    set() {},
  }
  const dispatch = makeDispatch()

  for (const header of ['if-match', 'if-unmodified-since', 'if-range']) {
    const res = await rawRequest(dispatch, {
      origin: origin(server),
      method: 'GET',
      path: '/x',
      headers: { [header]: '"v1"' },
      cache: { store },
    })
    t.equal(res.body, 'origin-body', `${header}: forwarded to origin`)
  }
  t.equal(gets, 0, 'store.get never called for bypassing conditionals')
  t.equal(hits, 3)
  t.end()
})

test('fresh 206 entry from a range-unaware store is not served to a non-range request', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {})
    res.end('full-body')
  })
  t.teardown(() => server.close())

  const store = {
    get() {
      return freshEntry('partial', {
        statusCode: 206,
        headers: { 'cache-control': 'max-age=60', 'content-range': 'bytes 0-6/100' },
      })
    },
    set() {},
  }
  const res = await rawRequest(makeDispatch(), {
    origin: origin(server),
    method: 'GET',
    path: '/x',
    headers: {},
    cache: { store },
  })
  t.equal(res.statusCode, 200, 'not the stored 206')
  t.equal(res.body, 'full-body', 'full representation fetched from origin')
  t.equal(hits, 1)
  t.end()
})

test('entry past deleteAt from a non-filtering store is treated as a miss', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {})
    res.end('origin-body')
  })
  t.teardown(() => server.close())

  const now = Date.now()
  const store = {
    get() {
      // Buggy store: never filters retention expiry.
      return freshEntry('zombie-body', { staleAt: now + 60e3, deleteAt: now - 1 })
    },
    set() {},
  }
  const res = await rawRequest(makeDispatch(), {
    origin: origin(server),
    method: 'GET',
    path: '/x',
    headers: {},
    cache: { store },
  })
  t.equal(res.body, 'origin-body', 'expired entry not served')
  t.equal(hits, 1)
  t.end()
})

test('async store degrades to a logged miss; rejected promises never escape', async (t) => {
  let hits = 0
  const seenIMS = []
  const server = await startServer((req, res) => {
    hits++
    seenIMS.push(req.headers['if-modified-since'] ?? null)
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('origin-body')
  })
  t.teardown(() => server.close())

  const rejections = []
  const onRejection = (err) => rejections.push(err)
  process.on('unhandledRejection', onRejection)
  t.teardown(() => process.removeListener('unhandledRejection', onRejection))

  const store = {
    async get() {
      throw new Error('redis connection lost')
    },
    async set() {
      throw new Error('redis connection lost')
    },
    async delete() {
      throw new Error('redis connection lost')
    },
  }
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), method: 'GET', path: '/x', headers: {}, cache: { store } }

  const res1 = await rawRequest(dispatch, opts)
  t.equal(res1.statusCode, 200)
  t.equal(res1.body, 'origin-body')
  t.equal(seenIMS[0], null, 'no bogus if-modified-since sent to the origin')

  // Unsafe method drives the async delete() path.
  const res2 = await rawRequest(dispatch, { ...opts, method: 'POST', body: null })
  t.equal(res2.statusCode, 200)

  await new Promise((r) => setTimeout(r, 50))
  t.strictSame(rejections, [], 'no unhandledRejection escaped')
  t.end()
})

test('store returning the set() value verbatim (Buffer[] body) still serves full bodies', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('hello-body')
  })
  t.teardown(() => server.close())

  const map = new Map()
  const store = {
    get(key) {
      return map.get(`${key.origin}${key.path}`)
    },
    set(key, value) {
      map.set(`${key.origin}${key.path}`, value) // verbatim: body stays Buffer[]
    },
  }
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), method: 'GET', path: '/x', headers: {}, cache: { store } }

  const miss = await rawRequest(dispatch, opts)
  t.equal(miss.body, 'hello-body')
  const hit = await rawRequest(dispatch, opts)
  t.equal(hit.body, 'hello-body', 'hit serves the full body, not an empty one')
  t.equal(hits, 1, 'second request was a cache hit')
  t.end()
})
