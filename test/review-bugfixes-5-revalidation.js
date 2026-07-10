/* eslint-disable */
// Regression tests for the 2026-07 cache deep-review fixes (304 freshening):
// - the validating response's Age header must feed the corrected initial age
//   (RFC 9111 §4.2.3/§4.3.4) — an intermediary answering the conditional from
//   its own store reports real age; discarding it over-extended freshness.
// - §4.3.4 validator identification: a 304 whose ETag does not match the
//   stored entry's must not freshen it or replace its validator (etag-swap
//   poisoning loop).
// - a 304 withdrawing cacheability (no-store/private) must also close the
//   stored entry's validation-free stale windows (max-stale/SWR), not leave
//   the old entry reusable until deleteAt.
// - the freshened entry's body must not be aliased between the store's
//   pending write batch and the chunk delivered to the user handler.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import { parseHttpDate } from '../lib/utils.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.cache())
}

function rawRequest(dispatch, opts, { onDataHook } = {}) {
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
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        chunks.push(Buffer.from(buf)) // private copy for assertions
        onDataHook?.(buf)
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

function seedStale(
  store,
  originStr,
  { body = 'stale-body', etag = '"v1"', directives = { 'max-age': 5 } } = {},
) {
  const now = Date.now()
  const buf = Buffer.from(body)
  store.set(
    { origin: originStr, method: 'GET', path: '/x', headers: {} },
    {
      body: buf,
      start: 0,
      end: buf.length,
      statusCode: 200,
      statusMessage: 'OK',
      headers: { etag, 'cache-control': 'max-age=5' },
      cacheControlDirectives: directives,
      etag,
      vary: {},
      cachedAt: now - 10e3,
      staleAt: now - 5e3,
      deleteAt: now + 3600e3,
    },
  )
}

const settle = () => new Promise((r) => setImmediate(r))

test('304 freshening honors the validating response Age header', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // An intermediary shared cache answering the conditional from its own
    // (old) copy: 304 + max-age=60 but Age: 100 — already stale.
    res.writeHead(304, {
      etag: '"v1"',
      'cache-control': 'max-age=60',
      age: '100',
      date: new Date().toUTCString(),
    })
    res.end()
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), method: 'GET', path: '/x', headers: {}, cache: { store } }

  seedStale(store, origin(server))
  await settle()

  const res1 = await rawRequest(dispatch, opts)
  t.equal(res1.statusCode, 200)
  t.equal(res1.body, 'stale-body')
  t.ok(hits >= 1, 'first request revalidated')
  t.ok(
    Number(res1.headers.age) >= 100,
    `served Age reflects the 304's Age (got ${res1.headers.age})`,
  )

  await settle()
  const hitsBefore = hits
  const res2 = await rawRequest(dispatch, opts)
  t.equal(res2.body, 'stale-body')
  t.ok(
    hits > hitsBefore,
    'second request revalidates again: Age 100 > max-age 60 means the freshened entry is still stale',
  )
  t.end()
})

test('304 freshening appends a missing Date at validation receipt', async (t) => {
  const server = await startServer((req, res) => {
    res.sendDate = false
    res.writeHead(304, { etag: '"v1"', 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), method: 'GET', path: '/x', headers: {}, cache: { store } }

  seedStale(store, origin(server))
  await settle()
  const earliestReceipt = Date.now() - 1000

  const response = await rawRequest(dispatch, opts)
  const receivedDate = parseHttpDate(response.headers.date)?.getTime()
  t.ok(
    receivedDate != null && receivedDate >= earliestReceipt && receivedDate <= Date.now(),
    'served metadata carries the 304 receipt-time Date',
  )

  await settle()
  const entry = store.get(undici.util.cache.makeCacheKey(opts))
  t.equal(entry.headers.date, response.headers.date, 'the generated 304 Date updated storage')
  t.end()
})

test('304 with a non-matching ETag retries unconditionally instead of serving stale', async (t) => {
  let hits = 0
  const seenINM = []
  const server = await startServer((req, res) => {
    hits++
    seenINM.push(req.headers['if-none-match'] ?? null)
    if (req.headers['if-none-match']) {
      res.writeHead(304, { etag: '"v2"', 'cache-control': 'max-age=60' })
      res.end()
    } else {
      res.writeHead(200, { etag: '"v2"', 'cache-control': 'max-age=60' })
      res.end('fresh-v2-body')
    }
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), method: 'GET', path: '/x', headers: {}, cache: { store } }

  seedStale(store, origin(server), { etag: '"v1"' })
  await settle()

  const res1 = await rawRequest(dispatch, opts)
  t.equal(res1.statusCode, 200)
  t.equal(res1.body, 'fresh-v2-body', 'unidentified stored bytes were not served')
  t.equal(seenINM[0], '"v1"', 'first conditional used the stored validator')
  t.equal(seenINM[1], null, 'mismatching 304 was recovered with an unconditional request')
  t.equal(hits, 2, 'the logical request needed one recovery fetch')

  await settle()
  const res2 = await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'the full recovery response was cached')
  t.equal(res2.body, 'fresh-v2-body')
  t.end()
})

test('304 with a duplicated (array) ETag does not evade the identification guard', async (t) => {
  let hits = 0
  const seenINM = []
  const server = await startServer((req, res) => {
    hits++
    seenINM.push(req.headers['if-none-match'] ?? null)
    if (req.headers['if-none-match']) {
      // Two ETag field lines (malformed) — undici parses them into an array.
      res.setHeader('etag', ['"v2"', '"v3"'])
      res.setHeader('cache-control', 'max-age=60')
      res.writeHead(304)
      res.end()
    } else {
      res.writeHead(200, { etag: '"v3"', 'cache-control': 'max-age=60' })
      res.end('fresh-v3-body')
    }
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), method: 'GET', path: '/x', headers: {}, cache: { store } }

  seedStale(store, origin(server), { etag: '"v1"' })
  await settle()

  const res1 = await rawRequest(dispatch, opts)
  t.equal(res1.statusCode, 200)
  t.equal(res1.body, 'fresh-v3-body', 'malformed validator did not validate the stored bytes')

  await settle()
  const res2 = await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'the unconditional recovery response was cached')
  t.equal(seenINM[1], null, 'the recovery request omitted the cache validator')
  t.equal(res2.body, 'fresh-v3-body')
  t.end()
})

test('304 withdrawing cacheability (no-store) closes the max-stale window on the stored entry', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    if (req.headers['if-none-match']) {
      res.writeHead(304, { 'cache-control': 'no-store' })
      res.end()
    } else {
      res.writeHead(200, { 'cache-control': 'no-store' })
      res.end('fresh-uncacheable')
    }
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const base = { origin: origin(server), method: 'GET', path: '/x', cache: { store } }

  seedStale(store, origin(server), { etag: '"v1"' })
  await settle()

  const res1 = await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(res1.body, 'stale-body', 'the withdrawal 304 still serves the validated use')
  t.equal(hits, 1)

  await settle()
  // Pre-fix the stored entry survived untouched and max-stale served it with
  // ZERO origin contact despite the origin having withdrawn cacheability.
  const res2 = await rawRequest(dispatch, {
    ...base,
    headers: { 'cache-control': 'max-stale=600' },
  })
  t.equal(hits, 2, 'entry no longer reusable: origin contacted')
  t.equal(res2.body, 'fresh-uncacheable')
  t.end()
})

test('freshened entry body is not aliased with the chunk delivered to the user', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(304, { etag: '"v1"', 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), method: 'GET', path: '/x', headers: {}, cache: { store } }

  seedStale(store, origin(server), { etag: '"v1"', body: 'hello-cached-body' })
  await settle()

  // Hostile/buggy consumer mutates the delivered chunk in place.
  const res1 = await rawRequest(dispatch, opts, { onDataHook: (chunk) => chunk.fill(0x58) })
  t.equal(res1.statusCode, 200)

  await settle()
  const res2 = await rawRequest(dispatch, opts)
  t.equal(
    res2.body,
    'hello-cached-body',
    'stored bytes unaffected by consumer mutation of the served chunk',
  )
  t.end()
})
