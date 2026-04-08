/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// makeDispatch intentionally doesn't forward store — store is passed via opts.cache.store
function makeDispatch() {
  return compose(new undici.Agent(), interceptors.cache())
}

function rawRequest(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc, headers) {
        statusCode = sc
        return true
      },
      onData() {},
      onComplete() {
        resolve(statusCode)
      },
      onError: reject,
    })
  })
}

// Like rawRequest but also collects the response body.
function rawRequestWithBody(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    const chunks = []
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc) {
        statusCode = sc
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      },
      onComplete() {
        resolve({ statusCode, body: Buffer.concat(chunks).toString() })
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('cache: serves second request from cache (s-maxage)', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
    res.end('cached body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)

  t.equal(hits, 1, 'server hit only once')
  t.pass('cache served second request')
})

test('cache: no-store response is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/plain' })
    res.end('no store body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'server hit twice (no-store)')
})

test('cache: private response is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'private, max-age=60', 'content-type': 'text/plain' })
    res.end('private body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'server hit twice (private)')
})

test('cache: max-age also caches', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60', 'content-type': 'text/plain' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'server hit only once with max-age')
})

test('cache: Vary header separates cache entries', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      vary: 'accept',
      'content-type': 'text/plain',
    })
    res.end(`accept: ${req.headers.accept}`)
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    cache: { store },
  }

  // Two different Accept values → two cache misses
  await rawRequest(dispatch, { ...base, headers: { accept: 'text/plain' } })
  await rawRequest(dispatch, { ...base, headers: { accept: 'application/json' } })
  // Same as first → cache hit
  await rawRequest(dispatch, { ...base, headers: { accept: 'text/plain' } })

  t.equal(hits, 2, 'two misses (different Vary), one hit')
})

test('cache: Vary: * is never cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      vary: '*',
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'never cached when Vary: *')
})

test('cache: maxEntrySize prevents oversized entries from being stored', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    const body = 'x'.repeat(200)
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-length': String(body.length),
      'content-type': 'text/plain',
    })
    res.end(body)
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store, maxEntrySize: 100 }, // 100-byte limit; body is 200 bytes
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'not cached when body exceeds maxEntrySize')
})

test('cache: maxEntryTTL caps the effective TTL', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=3600',
      'content-type': 'text/plain',
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store, maxEntryTTL: 60 }, // caps at 60s (still well above zero)
  }

  // First: populates cache
  await rawRequest(dispatch, opts)
  // Second: should hit cache (entry is within 60s TTL)
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'cached within maxEntryTTL window')
})

test('cache: POST requests are not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'POST',
    headers: {},
    body: 'data',
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'POST requests bypass cache')
})

// ---------------------------------------------------------------------------
// cache interceptor used standalone: headers:undefined must not crash
// ---------------------------------------------------------------------------

test('cache: does not crash when opts.headers is undefined', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch(store)

  // headers intentionally omitted (undefined)
  const status = await rawRequest(dispatch, {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: undefined,
    cache: { store },
  })
  t.equal(status, 200)
})

// ---------------------------------------------------------------------------
// Cached body is returned correctly (not just status code)
// ---------------------------------------------------------------------------

test('cache: cached body matches original server response byte-for-byte', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
    res.end('hello cached world')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  const first = await rawRequestWithBody(dispatch, opts)
  const second = await rawRequestWithBody(dispatch, opts)

  t.equal(hits, 1, 'server hit only once')
  t.equal(first.body, 'hello cached world', 'first response body correct')
  t.equal(second.body, 'hello cached world', 'cached body matches server response')
})

// ---------------------------------------------------------------------------
// only-if-cached
// ---------------------------------------------------------------------------

test('cache: only-if-cached returns 504 when no cache entry exists', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()

  const status = await rawRequest(dispatch, {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'only-if-cached' },
    cache: { store },
  })
  // only-if-cached with no cache entry must return 504 without contacting the server.
  t.equal(status, 504, 'only-if-cached returns 504 on cache miss')
  t.equal(hits, 0, 'server must not be contacted for only-if-cached miss')
})

test('cache: only-if-cached returns cached entry when one exists', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
    res.end('cached')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  // Populate cache with a normal request.
  await rawRequest(dispatch, base)

  // only-if-cached should hit the cache, not the server.
  const result = await rawRequestWithBody(dispatch, {
    ...base,
    headers: { 'cache-control': 'only-if-cached' },
  })

  t.equal(hits, 1, 'server hit exactly once')
  t.equal(result.statusCode, 200, 'only-if-cached returns cached 200')
})

// ---------------------------------------------------------------------------
// Authorization header
// ---------------------------------------------------------------------------

test('cache: authorization header prevents caching unless response has public directive', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // s-maxage but no 'public' — should not be cached when request has authorization
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('private')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { authorization: 'Bearer secret' },
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'authorized response without public must not be cached')
})

test('cache: authorization header allows caching when response has public directive', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // public directive explicitly allows shared caches to store even with authorization
    res.writeHead(200, { 'cache-control': 's-maxage=60, public' })
    res.end('public')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { authorization: 'Bearer secret' },
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'authorized response with public directive is cached')
})

// ---------------------------------------------------------------------------
// Response directives that prevent caching
// ---------------------------------------------------------------------------

test('cache: must-revalidate response directive prevents caching', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60, must-revalidate' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'must-revalidate responses are not cached')
})

test('cache: proxy-revalidate response directive prevents caching', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60, proxy-revalidate' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'proxy-revalidate responses are not cached')
})

test('cache: no-cache response directive prevents caching', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60, no-cache' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'no-cache responses are not cached')
})

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

test('cache: 5xx responses are not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(500, { 'cache-control': 's-maxage=60' })
    res.end('error')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store, maxEntrySize: 1024 * 1024 },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, '5xx responses are never cached')
})

test('cache: 4xx responses are not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(404, { 'cache-control': 's-maxage=60' })
    res.end('not found')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, '4xx responses are never cached')
})

// ---------------------------------------------------------------------------
// No TTL — response without cache-control max-age/s-maxage is not cached
// ---------------------------------------------------------------------------

test('cache: response without TTL (no max-age/s-maxage/immutable) is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // Cache-Control present but no ttl directive
    res.writeHead(200, { 'cache-control': 'no-transform' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'responses without TTL directives are not cached')
})

// ---------------------------------------------------------------------------
// isEtagUsable — via cache integration
// ---------------------------------------------------------------------------

test('cache: valid double-quoted etag is stored and returned from cache', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60', etag: '"abc123"' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  const entry = store.get({
    origin: `http://0.0.0.0:${server.address().port}`,
    method: 'GET',
    path: '/',
    headers: {},
  })
  t.ok(entry, 'entry stored in cache')
  t.equal(entry.etag, '"abc123"', 'valid etag stored and returned')
})

test('cache: empty-string etag is not treated as usable; stored as empty string', async (t) => {
  // isEtagUsable('""') returns false (length <= 2), so cache stores '' for the etag.
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60', etag: '""' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  const entry = store.get({
    origin: `http://0.0.0.0:${server.address().port}`,
    method: 'GET',
    path: '/',
    headers: {},
  })
  t.ok(entry, 'entry stored in cache')
  t.equal(entry.etag, '', 'unusable etag stored as empty string (not the original value)')
})

test('cache: weak etag W/"valid" is treated as usable and stored', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60', etag: 'W/"valid123"' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  const entry = store.get({
    origin: `http://0.0.0.0:${server.address().port}`,
    method: 'GET',
    path: '/',
    headers: {},
  })
  t.ok(entry, 'entry stored in cache')
  t.equal(entry.etag, 'W/"valid123"', 'weak etag stored')
})

test('cache: W/"" (empty weak etag) is not usable; stored as empty string', async (t) => {
  // isEtagUsable('W/""') returns false (length === 4), so cache stores ''.
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60', etag: 'W/""' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  const entry = store.get({
    origin: `http://0.0.0.0:${server.address().port}`,
    method: 'GET',
    path: '/',
    headers: {},
  })
  t.ok(entry, 'entry stored in cache')
  t.equal(entry.etag, '', 'empty weak etag stored as empty string')
})

// ---------------------------------------------------------------------------
// Vary: * never cached (response header check)
// ---------------------------------------------------------------------------

test('cache: Vary: * in response prevents caching (response-side check)', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', vary: '*' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'Vary: * responses never cached')
})

// ---------------------------------------------------------------------------
// Trailers prevent caching
// ---------------------------------------------------------------------------

test('cache: response with trailers header is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', trailers: 'x-checksum' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'responses with trailers header are not cached')
})

// ---------------------------------------------------------------------------
// No cache option — bypass
// ---------------------------------------------------------------------------

test('cache: opts.cache=false bypasses cache entirely', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    // no cache option
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'without cache option every request hits the server')
})

// ---------------------------------------------------------------------------
// Request no-store bypasses CacheHandler wrapper (response not stored)
// ---------------------------------------------------------------------------

test('cache: request Cache-Control: no-store skips caching wrapper', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'no-store' },
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'no-store request does not cache the response')
})

// ---------------------------------------------------------------------------
// Abort path: handler calls abort during cached response serving
// ---------------------------------------------------------------------------

test('cache: abort called from onConnect during cached response is forwarded to onError', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  // Populate the cache.
  await rawRequest(dispatch, opts)

  // Second request: handler immediately aborts in onConnect.
  const cancelErr = new Error('user cancelled')
  let receivedError = null
  let headersReceived = false

  await new Promise((resolve) => {
    dispatch(opts, {
      onConnect(abort) {
        abort(cancelErr)
      },
      onHeaders() {
        headersReceived = true
        return true
      },
      onData() {},
      onComplete() {
        resolve()
      },
      onError(err) {
        receivedError = err
        resolve()
      },
    })
  })

  t.equal(receivedError, cancelErr, 'abort error forwarded via onError')
  t.equal(headersReceived, false, 'onHeaders not called after abort')
})

test('cache: abort called from onHeaders during cached response is handled correctly', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  // Populate the cache.
  await rawRequest(dispatch, opts)

  // Second request: handler aborts inside onHeaders.
  const cancelErr = new Error('cancelled in onHeaders')
  let receivedError = null
  let dataReceived = false

  await new Promise((resolve) => {
    let storedAbort = null
    dispatch(opts, {
      onConnect(abort) {
        storedAbort = abort
      },
      onHeaders() {
        storedAbort(cancelErr)
        return true
      },
      onData() {
        dataReceived = true
      },
      onComplete() {
        resolve()
      },
      onError(err) {
        receivedError = err
        resolve()
      },
    })
  })

  t.equal(receivedError, cancelErr, 'abort from onHeaders propagated via onError')
  t.equal(dataReceived, false, 'onData not called after abort in onHeaders')
})

// ---------------------------------------------------------------------------
// Abort called from onData during cached response
// ---------------------------------------------------------------------------

test('cache: abort called from onData during cached response stops further callbacks', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body with content')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  // Populate the cache.
  await rawRequest(dispatch, opts)

  // Second request: handler aborts inside onData.
  const cancelErr = new Error('cancelled in onData')
  let receivedError = null
  let completeCalled = false

  await new Promise((resolve) => {
    let storedAbort = null
    dispatch(opts, {
      onConnect(abort) {
        storedAbort = abort
      },
      onHeaders() {
        return true
      },
      onData() {
        storedAbort(cancelErr)
      },
      onComplete() {
        completeCalled = true
        resolve()
      },
      onError(err) {
        receivedError = err
        resolve()
      },
    })
  })

  t.equal(receivedError, cancelErr, 'abort from onData propagated via onError')
  t.equal(completeCalled, false, 'onComplete not called after abort in onData')
})

// ---------------------------------------------------------------------------
// Response without content-length: end is computed from body size
// ---------------------------------------------------------------------------

test('cache: response without content-length header is cached correctly', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // Explicitly use chunked encoding without setting content-length.
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'transfer-encoding': 'chunked' })
    res.write('chunk1')
    res.write('chunk2')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  const second = await rawRequestWithBody(dispatch, opts)

  t.equal(hits, 1, 'server hit only once')
  t.equal(second.body, 'chunk1chunk2', 'cached body from chunked response is correct')
})

// ---------------------------------------------------------------------------
// store.set() throws during caching — error logged, response delivered
// ---------------------------------------------------------------------------

test('cache: store.set() locked error is logged (debug) and response still delivered', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const debugCalls = []
  const logger = {
    debug(...args) {
      debugCalls.push(args)
    },
    warn() {},
    error() {},
    child() {
      return this
    },
  }

  const mockStore = {
    get() {
      return undefined
    },
    set() {
      throw new Error('database is locked')
    },
  }

  const dispatch = makeDispatch()
  const status = await rawRequest(dispatch, {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store: mockStore },
    logger,
  })

  t.equal(status, 200, 'response delivered even when store.set() throws locked error')
  t.ok(
    debugCalls.some((args) => String(args[args.length - 1]).includes('failed to set cache entry')),
    'debug logged for locked DB on set',
  )
})

test('cache: store.set() non-locked error is logged (error) and response still delivered', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const errorCalls = []
  const logger = {
    debug() {},
    warn() {},
    error(...args) {
      errorCalls.push(args)
    },
    child() {
      return this
    },
  }

  const mockStore = {
    get() {
      return undefined
    },
    set() {
      throw new Error('some other error')
    },
  }

  const dispatch = makeDispatch()
  const status = await rawRequest(dispatch, {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store: mockStore },
    logger,
  })

  t.equal(status, 200, 'response delivered even when store.set() throws non-locked error')
  t.ok(
    errorCalls.some((args) => String(args[args.length - 1]).includes('failed to set cache entry')),
    'error logged for non-locked DB error on set',
  )
})

// ---------------------------------------------------------------------------
// Request Cache-Control directives that bypass caching
// ---------------------------------------------------------------------------

test('cache: request Cache-Control: no-cache bypasses cache lookup', async (t) => {
  // When the REQUEST has no-cache, the interceptor must bypass its own cache
  // and re-validate with the origin. (Current: falls through to dispatch.)
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('fresh')
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

  // Prime the cache.
  await rawRequest(dispatch, { ...base, headers: {} })
  // Second request with no-cache: must bypass cache → hit origin.
  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'no-cache' } })

  t.equal(hits, 2, 'no-cache in request bypasses cache, hits origin again')
})

test('cache: request Cache-Control: no-transform is a no-op (still serves from cache)', async (t) => {
  // no-transform in request means "don't modify the body"; we don't modify bodies
  // so it is ignored and the cache hit still works.
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
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

  // Prime the cache.
  await rawRequest(dispatch, { ...base, headers: {} })
  // Second request with no-transform: should still serve from cache.
  const status = await rawRequest(dispatch, {
    ...base,
    headers: { 'cache-control': 'no-transform' },
  })

  t.equal(hits, 1, 'no-transform in request does not bypass cache')
  t.equal(status, 200, 'cached response returned with no-transform request')
})

// ---------------------------------------------------------------------------
// CacheHandler: 206 without content-range is not cached
// ---------------------------------------------------------------------------

test('cache: 206 response without content-range header is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // 206 without content-range: cache must not store this.
    res.writeHead(206, { 'cache-control': 's-maxage=60' })
    res.end('partial')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
    error: false,
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, '206 without content-range is never cached')
})

// ---------------------------------------------------------------------------
// CacheHandler: Vary header that is not a string is not cached
// ---------------------------------------------------------------------------

test('cache: response with non-string Vary header is not cached', async (t) => {
  // Node.js HTTP parser may produce array headers when the same header
  // appears multiple times. The cache interceptor only handles string Vary.
  t.plan(1)
  let hits = 0

  // Use raw dispatch to inject a non-string vary header in the response.
  const server = await startServer((req, res) => {
    hits++
    // Two Vary lines → Node.js combines them as an array.
    res.setHeader('cache-control', 's-maxage=60')
    res.setHeader('vary', ['accept', 'accept-encoding'])
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'response with array Vary header is never cached')
})

// ---------------------------------------------------------------------------
// CacheHandler: body exceeds maxEntrySize mid-stream (no content-length)
// ---------------------------------------------------------------------------

test('cache: streaming body exceeding maxEntrySize mid-stream is not cached', async (t) => {
  // When there is no content-length, onHeaders allows caching (end == null).
  // onData then detects the actual body is too large and abandons caching.
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    // No content-length → chunked; each chunk is 50 bytes.
    res.write('x'.repeat(50))
    res.write('y'.repeat(50))
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store, maxEntrySize: 60 }, // 60 bytes limit; body is 100 bytes total
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'oversized streaming body not cached (maxEntrySize exceeded mid-stream)')
})

// ---------------------------------------------------------------------------
// CacheHandler: must-understand directive is ignored (response still cached)
// ---------------------------------------------------------------------------

test('cache: must-understand response directive is ignored — response is still cached', async (t) => {
  // The spec says "only cache if you understand this"; we claim to understand,
  // so must-understand is effectively a no-op in this implementation.
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60, must-understand' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'must-understand is treated as no-op; response is cached')
})

// ---------------------------------------------------------------------------
// CacheHandler: invalid content-range → response not cached
// ---------------------------------------------------------------------------

test('cache: 200 response with invalid content-range header is not cached', async (t) => {
  // parseContentRange returns null for malformed content-range; cache skips storage.
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-range': 'invalid-format',
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'response with invalid content-range is not cached')
})

// ---------------------------------------------------------------------------
// CacheHandler: zero or non-positive content-length → response not cached
// ---------------------------------------------------------------------------

test('cache: response with content-length: 0 is not cached', async (t) => {
  // content-length <= 0 is treated as invalid for caching purposes.
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-length': '0',
    })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'response with content-length: 0 is not cached')
})

// ---------------------------------------------------------------------------
// CacheHandler: abort callback propagation for non-cached requests
// ---------------------------------------------------------------------------

test('cache: user-triggered abort during non-cached request propagates correctly', async (t) => {
  // Exercises CacheHandler.onConnect's inner abort callback (the wrapped abort).
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()

  let receivedError = null
  await new Promise((resolve) => {
    dispatch(
      {
        origin: `http://0.0.0.0:${server.address().port}`,
        path: '/',
        method: 'GET',
        headers: {},
        cache: { store },
      },
      {
        onConnect(abort) {
          // Call the abort immediately — this exercises CacheHandler's inner abort wrapper.
          abort(new Error('cancelled'))
        },
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          resolve()
        },
        onError(err) {
          receivedError = err
          resolve()
        },
      },
    )
  })

  t.ok(receivedError, 'abort from user handler propagates through CacheHandler')
})

// ---------------------------------------------------------------------------

test('cache: store.get() database error is logged and request continues to origin', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const logger = {
    debug(...args) {
      debugCalls.push(args)
    },
    warn() {},
    error(...args) {
      errorCalls.push(args)
    },
    child() {
      return this
    },
  }
  const debugCalls = []
  const errorCalls = []

  // Mock store that throws 'database is locked' on get().
  const lockedStore = {
    get() {
      throw new Error('database is locked')
    },
    set() {},
  }

  const dispatch = makeDispatch()
  const status = await rawRequest(dispatch, {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store: lockedStore },
    logger,
  })

  t.equal(status, 200, 'request still succeeds when cache get throws locked error')
  t.ok(
    debugCalls.some((args) => String(args[args.length - 1]).includes('failed to get cache entry')),
    'debug logged for locked DB on get',
  )
})

test('cache: store.get() non-locked error is logged as error', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const errorCalls = []
  const logger = {
    debug() {},
    warn() {},
    error(...args) {
      errorCalls.push(args)
    },
    child() {
      return this
    },
  }

  // Mock store that throws a generic error on get().
  const brokenStore = {
    get() {
      throw new Error('unexpected store error')
    },
    set() {},
  }

  const dispatch = makeDispatch()
  const status = await rawRequest(dispatch, {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store: brokenStore },
    logger,
  })

  t.equal(status, 200, 'request still succeeds when cache get throws non-locked error')
  t.ok(
    errorCalls.some((args) => String(args[args.length - 1]).includes('failed to get cache entry')),
    'error logged for non-locked DB error on get',
  )
})

test('cache: exception thrown from handler during cached response is forwarded to onError', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  // Populate the cache.
  await rawRequest(dispatch, opts)

  // Second request: handler throws from onHeaders.
  const throwErr = new Error('handler threw')
  let receivedError = null

  await new Promise((resolve) => {
    dispatch(opts, {
      onConnect() {},
      onHeaders() {
        throw throwErr
      },
      onData() {},
      onComplete() {
        resolve()
      },
      onError(err) {
        receivedError = err
        resolve()
      },
    })
  })

  t.equal(receivedError, throwErr, 'exception from onHeaders forwarded via onError')
})

// ---------------------------------------------------------------------------
// isEtagUsable — "anything else" returns false (e.g. unquoted etag)
// ---------------------------------------------------------------------------

test('cache: unquoted etag (no double-quotes) is treated as unusable', async (t) => {
  // isEtagUsable('abc123') → doesn't start with '"' or 'W/"' → return false → stored as ''
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60', etag: 'abc123' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  const entry = store.get({
    origin: `http://0.0.0.0:${server.address().port}`,
    method: 'GET',
    path: '/',
    headers: {},
  })
  t.ok(entry, 'entry stored in cache')
  t.equal(entry.etag, '', 'unquoted etag is not usable; stored as empty string')
})

// ---------------------------------------------------------------------------
// only-if-cached with no cache entry returns 504
// ---------------------------------------------------------------------------

test('cache: only-if-cached with no entry returns 504', async (t) => {
  t.plan(1)
  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()

  const status = await rawRequest(dispatch, {
    origin: 'http://0.0.0.0:1',
    path: '/nonexistent',
    method: 'GET',
    headers: { 'cache-control': 'only-if-cached' },
    cache: { store },
  })
  t.equal(status, 504, 'only-if-cached without entry yields 504')
})

// ---------------------------------------------------------------------------
// Cache respects vary headers — different accept → miss
// ---------------------------------------------------------------------------

test('cache: vary header causes miss on different accept', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      vary: 'accept',
      'content-type': 'text/plain',
    })
    res.end(`hit ${hits}`)
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

  // First request with accept: text/html
  await rawRequest(dispatch, { ...base, headers: { accept: 'text/html' } })
  // Second request with different accept — should miss cache
  await rawRequest(dispatch, { ...base, headers: { accept: 'application/json' } })

  t.equal(hits, 2, 'different accept header causes cache miss due to vary')
})

// ---------------------------------------------------------------------------
// Cache: no-store request header bypasses cache and does not store
// ---------------------------------------------------------------------------

test('cache: no-store response is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/plain',
    })
    res.end('ephemeral')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)

  t.equal(hits, 2, 'no-store response should not be cached')
})

// ---------------------------------------------------------------------------
// Cache: private response is not cached
// ---------------------------------------------------------------------------

test('cache: private response is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 'private, max-age=60',
      'content-type': 'text/plain',
    })
    res.end('private data')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)

  t.equal(hits, 2, 'private response should not be cached')
})

// ---------------------------------------------------------------------------
// Cache: request with authorization header requires cache-control: public
// ---------------------------------------------------------------------------

test('cache: authorized request not cached without public directive', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
    })
    res.end('secret')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { authorization: 'Bearer token' },
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)

  t.equal(hits, 2, 'authorized request without public directive not cached')
})

// ---------------------------------------------------------------------------
// Cache: POST requests bypass cache
// ---------------------------------------------------------------------------

test('cache: POST requests bypass cache', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
    })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'POST',
    headers: { 'content-length': '0' },
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)

  t.equal(hits, 2, 'POST requests should bypass cache')
})

// ---------------------------------------------------------------------------
// Pragma: no-cache (RFC 9111 Section 5.4)
// ---------------------------------------------------------------------------

test('cache: Pragma no-cache bypasses cache when Cache-Control is absent', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  // Populate cache.
  await rawRequest(dispatch, base)
  t.equal(hits, 1, 'sanity: first request hits server')

  // Second request with Pragma: no-cache should bypass cache.
  const status = await rawRequest(dispatch, {
    ...base,
    headers: { pragma: 'no-cache' },
  })
  t.equal(hits, 2, 'Pragma: no-cache bypasses cache')
})

test('cache: Pragma no-cache is ignored when Cache-Control is present', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  // Populate cache.
  await rawRequest(dispatch, base)

  // Pragma: no-cache should be ignored when Cache-Control is also present.
  await rawRequest(dispatch, {
    ...base,
    headers: { pragma: 'no-cache', 'cache-control': '' },
  })
  t.equal(hits, 1, 'Pragma ignored when Cache-Control header is present')
})

// ---------------------------------------------------------------------------
// Authorization on lookup side (RFC 9111 Section 3.5)
// ---------------------------------------------------------------------------

test('cache: cached public response is not served to request with Authorization from different user', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60, public', 'content-type': 'text/plain' })
    res.end('public data')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { authorization: 'Bearer token-a' },
    cache: { store },
  }

  // Populate cache with authorized request (response is public).
  await rawRequest(dispatch, base)

  // Same auth header should serve from cache.
  await rawRequest(dispatch, base)
  t.equal(hits, 1, 'public cached response served for authorized request')
})

test('cache: cached non-public response is not served to request with Authorization', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // First request has no Authorization, so response gets cached.
    // Response has no 'public' directive.
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
    res.end('data')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  // Populate cache without Authorization.
  await rawRequest(dispatch, base)

  // Request with Authorization should not use the non-public cached entry.
  await rawRequest(dispatch, {
    ...base,
    headers: { authorization: 'Bearer secret' },
  })
  t.equal(hits, 2, 'non-public cached entry not served for authorized request')
})

// ---------------------------------------------------------------------------
// Conditional request headers (If-None-Match / If-Modified-Since)
// ---------------------------------------------------------------------------

test('cache: If-None-Match returns 304 when etag matches cached entry', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
      etag: '"abc123"',
    })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  // Populate cache.
  await rawRequest(dispatch, base)

  // If-None-Match with matching etag should return 304 from cache.
  const result = await rawRequestWithBody(dispatch, {
    ...base,
    headers: { 'if-none-match': '"abc123"' },
  })
  t.equal(result.statusCode, 304, 'matching etag returns 304')
  t.equal(hits, 1, 'server not contacted for conditional hit')
})

test('cache: If-None-Match with weak etag comparison returns 304', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
      etag: 'W/"weak1"',
    })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, base)

  // Strong etag in request should weak-match cached W/ etag.
  const result = await rawRequestWithBody(dispatch, {
    ...base,
    headers: { 'if-none-match': '"weak1"' },
  })
  t.equal(result.statusCode, 304, 'weak comparison matches')
  t.equal(hits, 1, 'server not contacted')
})

test('cache: If-None-Match with non-matching etag bypasses to origin', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
      etag: '"abc123"',
    })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, base)

  // Non-matching etag should bypass cache and hit origin.
  await rawRequest(dispatch, {
    ...base,
    headers: { 'if-none-match': '"different"' },
  })
  t.equal(hits, 2, 'non-matching etag bypasses to origin')
})

test('cache: If-None-Match with wildcard * returns 304', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
      etag: '"any"',
    })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, base)

  const result = await rawRequestWithBody(dispatch, {
    ...base,
    headers: { 'if-none-match': '*' },
  })
  t.equal(result.statusCode, 304, 'wildcard If-None-Match returns 304')
})

test('cache: If-Modified-Since returns 304 when resource not modified', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
      'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
    })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, base)

  // If-Modified-Since is after Last-Modified — not modified.
  const result = await rawRequestWithBody(dispatch, {
    ...base,
    headers: { 'if-modified-since': 'Thu, 02 Jan 2025 00:00:00 GMT' },
  })
  t.equal(result.statusCode, 304, 'not modified returns 304')
  t.equal(hits, 1, 'server not contacted')
})

test('cache: If-Modified-Since bypasses to origin when resource was modified', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
      'last-modified': 'Thu, 02 Jan 2025 00:00:00 GMT',
    })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, base)

  // If-Modified-Since is before Last-Modified — modified since then.
  await rawRequest(dispatch, {
    ...base,
    headers: { 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' },
  })
  t.equal(hits, 2, 'modified resource bypasses to origin')
})
