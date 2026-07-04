/* eslint-disable */
// Stale-path behavior: origin revalidation (conditional requests, 304
// freshening), stale-while-revalidate, stale-if-error, and local evaluation
// of freshness-overriding request directives. Stale entries are seeded
// directly into the store (no sleeps) so every test is deterministic.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Seeds a (typically stale) entry the way CacheHandler would have stored it.
function seedEntry(
  store,
  originStr,
  {
    path = '/',
    method = 'GET',
    body = 'cached-body',
    headers = {},
    cacheControlDirectives = {},
    etag = '',
    // Offsets relative to now, in ms.
    cachedAtOffset = -10e3,
    staleAtOffset = -5e3,
    deleteAtOffset = 3600e3,
  } = {},
) {
  const now = Date.now()
  const buf = Buffer.from(body)
  store.set(
    { origin: originStr, method, path, headers: {} },
    {
      body: buf,
      start: 0,
      end: buf.byteLength,
      statusCode: 200,
      statusMessage: '',
      headers,
      cacheControlDirectives,
      etag,
      vary: {},
      cachedAt: now + cachedAtOffset,
      staleAt: now + staleAtOffset,
      deleteAt: now + deleteAtOffset,
    },
  )
}

// Bounded poll — never waits forever (see global waiting guidelines).
async function waitFor(cond, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// Conditional revalidation: 304 serves and freshens the stored entry
// ---------------------------------------------------------------------------

test('revalidation: stale entry with etag revalidates with if-none-match; 304 serves cached body', async (t) => {
  t.plan(6)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    headers: { 'cache-control': 'max-age=5', 'last-modified': 'Sat, 04 Jul 2026 10:00:00 GMT' },
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.statusCode, 200, 'client sees 200, not the 304')
  t.equal(first.body, 'cached-body', 'validated cached body is served')
  t.equal(seen.length, 1, 'origin was asked once')
  t.equal(seen[0]['if-none-match'], '"v1"', 'if-none-match carries the stored etag')
  t.equal(
    seen[0]['if-modified-since'],
    'Sat, 04 Jul 2026 10:00:00 GMT',
    'if-modified-since echoes the stored last-modified verbatim',
  )

  // The 304's max-age=60 freshened the entry: next request never hits origin.
  await flush()
  const second = await rawRequest(dispatch, opts)
  t.equal(seen.length, 1, 'freshened entry is served without contacting the origin')
})

test('revalidation: freshening resets the Age', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cachedAtOffset: -100e3,
    staleAtOffset: -95e3,
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  await flush()
  const second = await rawRequest(dispatch, opts)
  t.ok(second.headers.age != null, 'age header present')
  t.ok(Number(second.headers.age) <= 1, `age is reset after freshening (got ${second.headers.age})`)
})

test('revalidation: replacement 200 is delivered and stored', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60', etag: '"v2"' })
    res.end('new-body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.body, 'new-body', 'replacement body is delivered')

  await flush()
  const second = await rawRequest(dispatch, opts)
  t.equal(second.body, 'new-body', 'replacement was stored')
  t.equal(hits, 1, 'second request served from cache')
})

test('revalidation: entry without etag falls back to if-modified-since from cachedAt', async (t) => {
  t.plan(3)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.statusCode, 200)
  t.equal(seen[0]['if-none-match'], undefined, 'no etag, no if-none-match')
  t.ok(seen[0]['if-modified-since'].endsWith(' GMT'), 'if-modified-since derived from cachedAt')
})

// ---------------------------------------------------------------------------
// Store-and-revalidate: response no-cache with a validator
// ---------------------------------------------------------------------------

test('revalidation: no-cache + etag response is stored and revalidated on every hit (#5515)', async (t) => {
  t.plan(6)
  let hits = 0
  let conditional = 0
  const server = await startServer((req, res) => {
    hits++
    if (req.headers['if-none-match'] === '"v1"') {
      conditional++
      res.writeHead(304)
      res.end()
    } else {
      res.writeHead(200, { 'cache-control': 'no-cache', etag: '"v1"' })
      res.end('validated-body')
    }
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.body, 'validated-body')
  await flush()

  const second = await rawRequest(dispatch, opts)
  t.equal(second.body, 'validated-body', 'cached body served after 304 validation')
  t.equal(hits, 2, 'every reuse revalidates with the origin')
  t.equal(conditional, 1, 'second request was conditional')

  // The freshened (post-304) entry must keep the no-cache semantics: a third
  // request revalidates again from the entry the 304 re-stored.
  await flush()
  const third = await rawRequest(dispatch, opts)
  t.equal(third.body, 'validated-body', 'freshened entry still serves the cached body')
  t.equal(conditional, 2, 'the freshened entry is validated again, not served blindly')
})

test('revalidation: entry no-cache directive forces validation even while fresh', async (t) => {
  t.plan(2)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(304)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  // Fresh (staleAt in the future) but marked no-cache.
  seedEntry(store, origin(server), {
    etag: '"v1"',
    staleAtOffset: 60e3,
    cacheControlDirectives: { 'no-cache': true, 'max-age': 70 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.body, 'cached-body')
  t.equal(seen.length, 1, 'fresh no-cache entry still validated with origin')
})

// ---------------------------------------------------------------------------
// stale-if-error (RFC 5861 §4)
// ---------------------------------------------------------------------------

test('stale-if-error: origin 503 during revalidation serves the stale entry', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(503)
    res.end('boom')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5, 'stale-if-error': 60 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.statusCode, 200, 'stale entry served instead of the 503')
  t.equal(res.body, 'cached-body')
})

test('stale-if-error: serves stale without waiting for the 5xx body to drain', async (t) => {
  t.plan(2)
  let bodyFullySent = false
  const server = await startServer((req, res) => {
    res.writeHead(503, { 'content-length': '1000000' })
    res.write(Buffer.alloc(16)) // headers + a little body, then hang
    // Deliberately never end() — if the interceptor waited for the body to
    // drain before serving stale, this request would hang until teardown.
    res.on('close', () => {
      bodyFullySent = false
    })
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5, 'stale-if-error': 60 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.body, 'cached-body', 'stale entry served promptly, before the 5xx body finished')
  t.equal(bodyFullySent, false, 'origin never finished sending its body')
})

test('stale-if-error: without the directive the 503 is passed through', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(503)
    res.end('boom')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.statusCode, 503, '503 replacement is delivered')
  t.equal(res.body, 'boom')
})

test('stale-if-error: connection error before response serves the stale entry (#5513)', async (t) => {
  t.plan(2)
  // Port 1 (tcpmux) is privileged and never bound in practice — connecting
  // yields a deterministic ECONNREFUSED without the port-reuse race of
  // binding-then-closing a listener under parallel test load.
  const originStr = 'http://127.0.0.1:1'

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, originStr, {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5, 'stale-if-error': 60 },
  })
  const opts = { origin: originStr, path: '/', method: 'GET', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.statusCode, 200, 'unreachable origin within stale-if-error serves stale')
  t.equal(res.body, 'cached-body')
})

test('stale-if-error: request directive works as fallback window', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(500)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5 },
  })
  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'stale-if-error=60' },
    cache: { store },
  })
  t.equal(res.statusCode, 200, 'request stale-if-error honored on origin 5xx')
})

test('stale-if-error: must-revalidate vetoes serving stale (#5511)', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(503)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5, 'stale-if-error': 60, 'must-revalidate': true },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.statusCode, 503, 'must-revalidate forbids the stale-if-error serve')
})

// ---------------------------------------------------------------------------
// stale-while-revalidate (RFC 5861 §3)
// ---------------------------------------------------------------------------

test('stale-while-revalidate: stale entry within window is served immediately, refreshed in background', async (t) => {
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { 'cache-control': 'max-age=60, stale-while-revalidate=60', etag: '"v2"' })
    res.end('refreshed')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5, 'stale-while-revalidate': 60 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.statusCode, 200)
  t.equal(first.body, 'cached-body', 'stale body served without waiting for the origin')

  await waitFor(() => seen.length === 1)
  t.equal(seen[0]['if-none-match'], '"v1"', 'background refresh is a conditional request')

  // Give the refresh time to store, then confirm the entry was replaced.
  await waitFor(() => {
    const entry = store.get({ origin: origin(server), method: 'GET', path: '/', headers: {} })
    return entry?.etag === '"v2"'
  })
  const second = await rawRequest(dispatch, opts)
  t.equal(second.body, 'refreshed', 'refreshed entry served afterwards')
  t.equal(seen.length, 1, 'no additional origin hit for the refreshed entry')
  t.end()
})

test('stale-while-revalidate: outside the window revalidates synchronously', async (t) => {
  t.plan(2)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  // Stale by 100s, swr window only 60s.
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cachedAtOffset: -110e3,
    staleAtOffset: -100e3,
    cacheControlDirectives: { 'max-age': 10, 'stale-while-revalidate': 60 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.body, 'cached-body', '304 validated the entry')
  t.equal(seen.length, 1, 'origin consulted before serving (synchronous revalidation)')
})

// ---------------------------------------------------------------------------
// Request directives evaluated locally
// ---------------------------------------------------------------------------

test('request no-cache: revalidates a fresh entry instead of serving it', async (t) => {
  t.plan(3)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    staleAtOffset: 60e3,
    cacheControlDirectives: { 'max-age': 70 },
  })

  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'no-cache' },
    cache: { store },
  })
  t.equal(res.statusCode, 200)
  t.equal(res.body, 'cached-body', 'validated body served')
  t.equal(seen.length, 1, 'origin was consulted despite the entry being fresh')
})

test('request no-cache on a cache miss still stores the response (write-back, #5510)', async (t) => {
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
  const base = { origin: origin(server), path: '/', method: 'GET', cache: { store } }

  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'no-cache' } })
  t.equal(hits, 1)
  await flush()

  // The no-cache fetch must not have disabled caching for everyone else.
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 1, 'plain request is served from the entry stored by the no-cache fetch')
})

test('request max-age=0 forces validation and exceeded max-age keeps write-back (undici #5504)', async (t) => {
  t.plan(4)
  let hits = 0
  let conditional = 0
  const server = await startServer((req, res) => {
    hits++
    if (req.headers['if-none-match']) {
      conditional++
    }
    res.writeHead(200, { 'cache-control': 'max-age=60', etag: '"v2"' })
    res.end('hello')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', method: 'GET', cache: { store } }

  // The exact #5504 repro shape: populate, then request with max-age=0
  // (what fetch cache:'no-cache' sends) — must NOT be a silent cache hit.
  await rawRequest(dispatch, { ...base, headers: {} })
  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'max-age=0' } })
  t.equal(hits, 2, 'max-age=0 contacted the origin (not a falsy-dropped directive)')
  t.equal(conditional, 1, 'and did so with a conditional request')

  // Secondary #5504 claim: the response fetched because of the max-age bypass
  // must still update the store — the next plain request is a cache hit.
  await flush()
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 2, 'replacement was stored (write-back preserved)')
  t.pass('write-back verified')
})

test('request max-age=0: revalidates a fresh entry', async (t) => {
  t.plan(2)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    staleAtOffset: 60e3,
    cacheControlDirectives: { 'max-age': 70 },
  })

  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'max-age=0' },
    cache: { store },
  })
  t.equal(res.body, 'cached-body')
  t.equal(seen.length, 1, 'max-age=0 demanded validation')
})

test('request max-stale: serves a stale entry within the tolerance without origin contact', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(304)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  // Stale by 5s.
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5 },
  })
  const base = { origin: origin(server), path: '/', method: 'GET', cache: { store } }

  const res = await rawRequest(dispatch, {
    ...base,
    headers: { 'cache-control': 'max-stale=30' },
  })
  t.equal(res.body, 'cached-body', 'stale-by-5s entry served under max-stale=30')
  t.equal(hits, 0, 'origin not contacted')

  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'max-stale=2' } })
  t.equal(hits, 1, 'staleness beyond max-stale=2 revalidates')
})

test('request bare max-stale accepts any staleness', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(304)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cachedAtOffset: -1000e3,
    staleAtOffset: -995e3,
    cacheControlDirectives: { 'max-age': 5 },
  })

  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'max-stale' },
    cache: { store },
  })
  t.equal(res.body, 'cached-body')
  t.equal(hits, 0, 'bare max-stale served an arbitrarily stale entry')
})

test('request max-stale: must-revalidate vetoes serving stale', async (t) => {
  t.plan(1)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(1)
    res.writeHead(304)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5, 'must-revalidate': true },
  })

  await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'max-stale=300' },
    cache: { store },
  })
  t.equal(seen.length, 1, 'must-revalidate entry validated despite max-stale')
})

test('only-if-cached: stale entry without max-stale returns 504', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5 },
  })

  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'only-if-cached' },
    cache: { store },
  })
  t.equal(res.statusCode, 504, 'stale entry is not usable for only-if-cached')
  t.equal(hits, 0, 'origin never contacted')
})

test('caller conditionals against a stale entry are forwarded to the origin', async (t) => {
  t.plan(3)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304)
      res.end()
    } else {
      res.writeHead(200)
      res.end('fresh')
    }
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5 },
  })

  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'if-none-match': '"v1"' },
    cache: { store },
  })
  t.equal(res.statusCode, 304, "origin's 304 flows to the caller")
  t.equal(seen.length, 1, 'stale entry did not answer the conditional locally')
  t.equal(seen[0]['if-none-match'], '"v1"', "caller's own validator was forwarded")
})

// ---------------------------------------------------------------------------
// Review regressions: request bounds vs stale-serving windows, 304 freshening
// edge cases, aborts, HEAD
// ---------------------------------------------------------------------------

test('request max-age is not nullified by max-stale (review)', async (t) => {
  t.plan(2)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(304, { 'cache-control': 'max-age=3600' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  // Origin-fresh entry (staleAt far in the future) aged 300s.
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cachedAtOffset: -300e3,
    staleAtOffset: 3300e3,
    cacheControlDirectives: { 'max-age': 3600 },
  })

  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'max-age=10, max-stale=600' },
    cache: { store },
  })
  t.equal(res.statusCode, 200)
  t.equal(seen.length, 1, 'entry older than the request max-age was validated, not served blindly')
})

test('request max-age=0 is not nullified by response stale-while-revalidate (review)', async (t) => {
  t.plan(2)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(304, { 'cache-control': 'max-age=60, stale-while-revalidate=300' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  // Fresh entry aged 30s with a wide SWR window.
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cachedAtOffset: -30e3,
    staleAtOffset: 30e3,
    cacheControlDirectives: { 'max-age': 60, 'stale-while-revalidate': 300 },
  })

  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'max-age=0' },
    cache: { store },
  })
  t.equal(res.body, 'cached-body')
  t.equal(seen.length, 1, 'max-age=0 validated synchronously despite the SWR window')
})

test('freshening: 304 without a Date header restarts the freshness clock (review)', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.sendDate = false
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  // Stored 300s ago with the origin's original Date header.
  seedEntry(store, origin(server), {
    etag: '"v1"',
    headers: { date: new Date(Date.now() - 300e3).toUTCString() },
    cachedAtOffset: -300e3,
    staleAtOffset: -295e3,
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  await flush()
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'the 304 granted 60s of freshness — second request never hit the origin')

  const entry = store.get({ origin: origin(server), method: 'GET', path: '/', headers: {} })
  t.ok(entry.staleAt > Date.now(), 'freshened entry is actually fresh')
})

test('freshening: 304 headers are merged with store-time exclusions (set-cookie, content-length) (review)', async (t) => {
  t.plan(4)
  const server = await startServer((req, res) => {
    res.writeHead(304, {
      'cache-control': 'max-age=60',
      'set-cookie': 'session=leak',
      'content-length': '9999',
      'x-fresh': 'merged',
    })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    headers: { 'x-old': 'kept' },
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.headers['set-cookie'], undefined, '304 Set-Cookie never reaches the shared entry')
  t.equal(res.headers['x-fresh'], 'merged', 'new 304 fields are merged in')
  t.equal(res.headers['x-old'], 'kept', 'stored fields survive the merge')
  t.equal(res.body, 'cached-body', 'stored body served (304 content-length ignored)')
})

test('revalidation: HEAD entry freshens and serves an empty body (review)', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const now = Date.now()
  store.set(
    { origin: origin(server), method: 'HEAD', path: '/', headers: {} },
    {
      body: null,
      start: 0,
      end: 0,
      statusCode: 200,
      statusMessage: '',
      headers: { 'content-length': '5' },
      cacheControlDirectives: { 'max-age': 5 },
      etag: '"v1"',
      vary: {},
      cachedAt: now - 10e3,
      staleAt: now - 5e3,
      deleteAt: now + 3600e3,
    },
  )
  const opts = { origin: origin(server), path: '/', method: 'HEAD', headers: {}, cache: { store } }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.statusCode, 200)
  t.equal(res.body, '', 'HEAD serves no body')

  await flush()
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'freshened HEAD entry served without another origin hit')
})

test('only-if-cached combined with max-stale serves a stale entry (review)', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5 },
  })

  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'only-if-cached, max-stale=30' },
    cache: { store },
  })
  t.equal(res.body, 'cached-body', 'max-stale makes the stale entry usable for only-if-cached')
  t.equal(hits, 0, 'origin never contacted')
})

test('abort during revalidation cancels the in-flight conditional request (review)', async (t) => {
  t.plan(2)
  let sawRequest = false
  const server = await startServer((req, res) => {
    sawRequest = true
    // Never answer — only an abort can end this request.
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5 },
  })

  const err = await new Promise((resolve, reject) => {
    dispatch(
      { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } },
      {
        onConnect(abort) {
          // Abort as soon as the handle exists — during the conditional flight.
          setTimeout(() => abort(new Error('user-abort')), 20)
        },
        onHeaders() {
          reject(new Error('should not receive headers'))
          return true
        },
        onData() {
          return true
        },
        onComplete() {
          reject(new Error('should not complete'))
        },
        onError: resolve,
      },
    )
  })
  t.equal(err.message, 'user-abort', "the user's abort reason surfaces via onError")
  t.ok(sawRequest, 'the conditional request had reached the origin')
})

test('request no-store: revalidation replacement is delivered but not stored', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60', etag: '"v2"' })
    res.end('replacement')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    cacheControlDirectives: { 'max-age': 5 },
  })
  const base = { origin: origin(server), path: '/', method: 'GET', cache: { store } }

  const res = await rawRequest(dispatch, {
    ...base,
    headers: { 'cache-control': 'no-store' },
  })
  t.equal(res.body, 'replacement')
  await flush()

  // The stale seeded entry is still there (superseded only on store), and the
  // replacement must not have been written: a plain request revalidates again.
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 2, 'no-store replacement was not written to the cache')
})
