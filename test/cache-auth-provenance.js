/* eslint-disable */
// RFC 9111 §3.5 provenance regressions: a response obtained through an
// Authorization request remains subject to the shared-cache grant after a
// 304 updates (and can replace) its Cache-Control field.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

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

test('authorized response is retired when a 304 withdraws its shared-cache grant', async (t) => {
  let hits = 0
  const seen = []
  const server = await startServer((req, res) => {
    hits++
    seen.push({ authorization: req.headers.authorization, etag: req.headers['if-none-match'] })

    if (hits === 1) {
      res.writeHead(200, { 'cache-control': 'public, max-age=0', etag: '"secret-v1"' })
      res.end('secret-body')
      return
    }
    if (hits === 2) {
      // Replaces the stored Cache-Control field. The body is unchanged, but
      // the updated stored response no longer has a §3.5 permission.
      res.writeHead(304, { 'cache-control': 'max-age=60', etag: '"secret-v1"' })
      res.end()
      return
    }

    res.writeHead(200, { 'cache-control': 'no-store' })
    res.end(req.headers.authorization ? 'authorized-origin' : 'anonymous-origin')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', method: 'GET', cache: { store } }
  const authorized = { ...base, headers: { authorization: 'Bearer secret' } }
  const key = { origin: base.origin, path: '/', method: 'GET', headers: {} }

  const initial = await rawRequest(dispatch, authorized)
  t.equal(initial.body, 'secret-body')
  t.equal(store.get(key)?.authorizationRequest, true, 'initial provenance is persisted')

  const validated = await rawRequest(dispatch, authorized)
  t.equal(validated.body, 'secret-body', 'the already-validated request receives the stored body')
  t.equal(hits, 2)
  t.equal(seen[1].authorization, 'Bearer secret')
  t.equal(seen[1].etag, '"secret-v1"')
  t.equal(store.get(key), undefined, 'grant withdrawal retires the stored representation')

  const anonymous = await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(anonymous.body, 'anonymous-origin', 'the secret is not reused anonymously')

  const authorizedAgain = await rawRequest(dispatch, authorized)
  t.equal(authorizedAgain.body, 'authorized-origin', 'the secret is not reused with Authorization')
  t.equal(hits, 4)
})

test('304 grant withdrawal fails closed when a custom store drops unknown provenance', async (t) => {
  // Emulates a pre-field custom store: it accepts the extended CacheValue but
  // only persists the fields it already knows. The transition itself must be
  // safe even before the store is upgraded to round-trip the marker.
  let entry
  const writes = []
  const store = {
    get() {
      if (entry == null || entry.deleteAt <= Date.now()) {
        return undefined
      }
      return { ...entry, body: entry.body ? Buffer.from(entry.body) : undefined }
    },
    set(_key, value) {
      writes.push(value)
      const { authorizationRequest: _dropped, ...known } = value
      entry = {
        ...known,
        body: Array.isArray(value.body)
          ? Buffer.concat(value.body)
          : value.body
            ? Buffer.from(value.body)
            : undefined,
      }
    },
    clear() {
      entry = undefined
    },
    close() {},
    gc() {},
  }

  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    if (hits === 1) {
      res.writeHead(200, { 'cache-control': 'public, max-age=0', etag: '"secret-v1"' })
      res.end('secret-body')
      return
    }
    if (hits === 2) {
      t.equal(req.headers.authorization, undefined, 'an anonymous request performs validation')
      res.writeHead(304, { 'cache-control': 'max-age=60', etag: '"secret-v1"' })
      res.end()
      return
    }
    res.writeHead(200, { 'cache-control': 'no-store' })
    res.end('anonymous-origin')
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', method: 'GET', cache: { store } }

  await rawRequest(dispatch, { ...base, headers: { authorization: 'Bearer secret' } })
  t.equal(writes[0].authorizationRequest, true, 'the interceptor supplies provenance to stores')

  const validated = await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(validated.body, 'secret-body')
  t.ok(writes.at(-1).deleteAt < Date.now(), 'unknown provenance plus a withdrawn grant expires')

  const anonymous = await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(anonymous.body, 'anonymous-origin')
  t.equal(hits, 3)
})

test('persisted Authorization provenance gates anonymous and authorized lookups', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'no-store' })
    res.end(req.headers.authorization ? 'authorized-origin' : 'anonymous-origin')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const originStr = origin(server)
  const now = Date.now()
  store.set(
    { origin: originStr, path: '/', method: 'GET', headers: {} },
    {
      body: Buffer.from('secret-body'),
      start: 0,
      end: 11,
      statusCode: 200,
      statusMessage: '',
      headers: { 'cache-control': 'max-age=60' },
      cacheControlDirectives: { 'max-age': 60 },
      authorizationRequest: true,
      vary: {},
      cachedAt: now,
      staleAt: now + 60e3,
      deleteAt: now + 120e3,
    },
  )

  const base = { origin: originStr, path: '/', method: 'GET', cache: { store } }
  const anonymous = await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(anonymous.body, 'anonymous-origin', 'anonymous lookup cannot reuse the entry')

  const authorized = await rawRequest(dispatch, {
    ...base,
    headers: { authorization: 'Bearer secret' },
  })
  t.equal(authorized.body, 'authorized-origin', 'authorized lookup cannot reuse the entry')
  t.equal(hits, 2)
})
