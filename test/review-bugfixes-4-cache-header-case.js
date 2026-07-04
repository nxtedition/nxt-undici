// Regression tests: request-directive and conditional-header guards in the
// cache interceptor must read header names case-insensitively. The standalone
// interceptors.cache() composition passes opts.headers through unnormalized,
// so a caller-supplied `Authorization`/`Cache-Control`/`If-None-Match` used to
// silently skip the lookup-side guards while the store side (CacheHandler)
// read the lowercased key.headers — e.g. serving a non-public cached response
// to an authorized request, violating RFC 9111 §3.5.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.cache())
}

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
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

// ---------------------------------------------------------------------------
// RFC 9111 §3.5: a capitalized Authorization header must not be served a
// cached non-public response (same behavior as lowercase `authorization`).
// ---------------------------------------------------------------------------

test('cache: capitalized Authorization is not served a cached non-public response', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      // max-age but no 'public'/'s-maxage'/'must-revalidate' — cacheable for
      // anonymous requests only (RFC 9111 §3.5).
      'cache-control': 'max-age=60',
      'content-type': 'text/plain',
    })
    res.end('non-public body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    cache: { store },
  }

  // Populate the cache without Authorization.
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 1, 'anonymous response is cached')

  // Capitalized Authorization must skip the non-public cached entry.
  await rawRequest(dispatch, { ...base, headers: { Authorization: 'Bearer secret' } })
  t.equal(hits, 2, 'authorized request goes to origin instead of the cache')
})

// ---------------------------------------------------------------------------
// A capitalized Cache-Control: no-store request directive must prevent the
// response from being stored, same as the lowercase form.
// ---------------------------------------------------------------------------

test('cache: capitalized Cache-Control: no-store prevents storing the response', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    cache: { store },
  }

  // no-store on the request: response must not be stored...
  await rawRequest(dispatch, { ...base, headers: { 'Cache-Control': 'no-store' } })
  // ...so a plain follow-up request must go to origin.
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 2, 'response requested with no-store was not stored')
})

// ---------------------------------------------------------------------------
// A capitalized If-None-Match must be evaluated against the cached etag, same
// as the lowercase form: matching etag → 304 from cache, non-matching etag →
// bypass to origin.
// ---------------------------------------------------------------------------

test('cache: capitalized If-None-Match behaves like lowercase', async (t) => {
  t.plan(5)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      etag: '"abc"',
      'content-type': 'text/plain',
    })
    res.end('etagged body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    cache: { store },
  }

  // Populate the cache.
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 1, 'response is cached')

  // Matching etag → 304 served from cache, no origin hit.
  const matched = await rawRequest(dispatch, { ...base, headers: { 'If-None-Match': '"abc"' } })
  t.equal(matched.statusCode, 304, 'matching If-None-Match yields 304')
  t.equal(hits, 1, '304 is served from cache without contacting origin')

  // Non-matching etag → bypass to origin.
  const missed = await rawRequest(dispatch, { ...base, headers: { 'If-None-Match': '"other"' } })
  t.equal(missed.statusCode, 200, 'non-matching If-None-Match yields the full response')
  t.equal(hits, 2, 'non-matching If-None-Match bypasses the cache to origin')
})

// ---------------------------------------------------------------------------
// Header names are caller-controlled, so the lowercased key-header map must be
// prototype-pollution safe. `__proto__` is a valid header token: on a plain
// `{}` map, assigning it hits the Object.prototype setter — string values are
// silently dropped (the header vanishes from the cache key, breaking Vary
// matching) and object values overwrite the map's prototype.
// ---------------------------------------------------------------------------

test('cache: a __proto__ request header is kept as a plain key and does not pollute', async (t) => {
  t.plan(4)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      vary: '__proto__',
      'content-type': 'text/plain',
    })
    res.end(`body-${hits}`)
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    cache: { store },
  }

  // Populate the cache with __proto__: a.
  await rawRequest(dispatch, { ...base, headers: { ['__proto__']: 'a' } })
  t.equal(hits, 1, 'response is cached')

  // Same __proto__ value → served from cache.
  await rawRequest(dispatch, { ...base, headers: { ['__proto__']: 'a' } })
  t.equal(hits, 1, 'matching __proto__ vary value is served from cache')

  // Different __proto__ value → Vary mismatch, must go to origin. With a
  // plain `{}` map the header is dropped from the key, so both requests
  // falsely share the cached entry.
  await rawRequest(dispatch, { ...base, headers: { ['__proto__']: 'b' } })
  t.equal(hits, 2, 'different __proto__ vary value goes to origin')

  t.equal({}.a, undefined, 'Object.prototype is not polluted')
})
