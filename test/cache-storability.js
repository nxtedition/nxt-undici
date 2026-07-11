/* eslint-disable */
// Storability and freshness-math behavior: Expires fallback, corrected initial
// age, §3.5 authorization permits, opt-in heuristic freshness / defaultTTL,
// header stripping, unsafe-method invalidation, query-in-key, and the store's
// delete()/supersede machinery.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import { parseHttpDate } from '../lib/utils.js'
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

const flush = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// parseHttpDate unit coverage (strict RFC 9110 formats only)
// ---------------------------------------------------------------------------

test('parseHttpDate: accepts the three RFC 9110 formats, rejects everything else', (t) => {
  const expected = Date.UTC(1994, 10, 6, 8, 49, 37)
  t.equal(parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT')?.getTime(), expected, 'IMF-fixdate')
  t.equal(parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT')?.getTime(), expected, 'RFC 850')
  t.equal(parseHttpDate('Sun Nov  6 08:49:37 1994')?.getTime(), expected, 'asctime')
  t.equal(parseHttpDate('0'), undefined, 'Expires: 0 is invalid')
  // Recipient leniency: a mismatched weekday NAME no longer rejects the date
  // (the numeric fields determine the moment; buggy origins exist) — see
  // review-bugfixes-5-directives.js.
  t.equal(
    parseHttpDate('Mon, 06 Nov 1994 08:49:37 GMT')?.getTime(),
    expected,
    'wrong weekday tolerated',
  )
  t.equal(parseHttpDate('Wed, 30 Feb 2022 00:00:00 GMT'), undefined, 'nonexistent date')
  t.equal(parseHttpDate('2026-07-04T00:00:00Z'), undefined, 'ISO 8601 is not an HTTP date')
  t.equal(parseHttpDate(123), undefined, 'non-string')
  t.end()
})

test('storability: a missing Date is appended at receipt before forwarding and storage', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.sendDate = false
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }
  const earliestReceipt = Date.now() - 1000

  const first = await rawRequest(dispatch, opts)
  const receivedDate = parseHttpDate(first.headers.date)?.getTime()
  t.ok(
    receivedDate != null && receivedDate >= earliestReceipt && receivedDate <= Date.now(),
    'forwarded response carries a receipt-time Date',
  )

  await flush()
  const entry = store.get(undici.util.cache.makeCacheKey(opts))
  t.equal(entry.headers.date, first.headers.date, 'the same generated Date is stored')

  const second = await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'the dated response is reusable from cache')
  t.equal(second.headers.date, first.headers.date, 'cache hit preserves the generated Date')
  t.end()
})

// ---------------------------------------------------------------------------
// Expires fallback (RFC 9111 §4.2.1 / §5.3)
// ---------------------------------------------------------------------------

test('storability: Expires-only response is cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      expires: new Date(Date.now() + 60e3).toUTCString(),
      date: new Date().toUTCString(),
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'future Expires provides the freshness lifetime')
})

test('storability: invalid Expires (0) means already expired — not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { expires: '0' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'Expires: 0 is treated as already expired (RFC 9111 §5.3)')
})

test('storability: past Expires with etag is stored for revalidation', async (t) => {
  t.plan(2)
  let hits = 0
  let conditional = 0
  const server = await startServer((req, res) => {
    hits++
    if (req.headers['if-none-match'] === '"e"') {
      conditional++
      res.writeHead(304)
      res.end()
    } else {
      res.writeHead(200, {
        expires: new Date(Date.now() - 60e3).toUTCString(),
        etag: '"e"',
      })
      res.end('body')
    }
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  await flush()
  const second = await rawRequest(dispatch, opts)
  t.equal(second.body, 'body', 'validated body served')
  t.equal(conditional, 1, 'second request revalidated instead of refetching')
})

// ---------------------------------------------------------------------------
// Corrected initial age (RFC 9111 §4.2.3)
// ---------------------------------------------------------------------------

test('storability: apparent age from the Date header counts against freshness', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // Generated 120s ago per Date, only 60s of freshness, no validator:
    // stale on arrival, must not be stored.
    res.writeHead(200, {
      'cache-control': 'max-age=60',
      date: new Date(Date.now() - 120e3).toUTCString(),
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'response stale on arrival (Date-based apparent age) is not cached')
})

test('storability: served Age includes the age the response arrived with', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', age: '5' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  const second = await rawRequest(dispatch, opts)
  t.equal(hits, 1)
  t.ok(Number(second.headers.age) >= 5, 'cachedAt backdating carries the initial age forward')
})

test('storability: malformed Age header is ignored, not coerced', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // "5junk" must not be read as 5s of age (which would backdate cachedAt).
    res.writeHead(200, { 'cache-control': 's-maxage=60', age: '5junk' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  const second = await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'still cached (malformed Age treated as absent)')
  t.equal(Number(second.headers.age), 0, 'malformed Age not coerced into initial age')
})

// ---------------------------------------------------------------------------
// Write-back on request-directive bypass (undici PR #5510): a request
// directive constrains reuse for THIS request, not storage of the fresh
// origin response for later callers.
// ---------------------------------------------------------------------------

test('write-back: a no-cache request on a cold cache still stores for later callers', async (t) => {
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

  // First request carries a bypass directive on an empty cache.
  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'no-cache' } })
  t.equal(hits, 1, 'no-cache request went to the origin')
  await flush()

  // A subsequent plain request is served from the entry the bypass stored.
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 1, 'fresh response was written back despite the request no-cache')
})

test('write-back: request no-store on a bypass does not store', async (t) => {
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

  // no-store forbids storing this request's response...
  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'no-store' } })
  t.equal(hits, 1)
  await flush()

  // ...so a plain follow-up must hit the origin again.
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 2, 'no-store bypass did not write back')
})

// ---------------------------------------------------------------------------
// RFC 9111 §3.5: authorization permits
// ---------------------------------------------------------------------------

test('authorization: s-maxage permits shared-cache storage and reuse (#4911)', async (t) => {
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
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { authorization: 'Bearer secret' },
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 's-maxage response cached and served for authorized requests')
})

test('authorization: must-revalidate permits storage for authorized requests', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60, must-revalidate' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { authorization: 'Bearer secret' },
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'must-revalidate response cached while fresh for authorized requests')
})

// ---------------------------------------------------------------------------
// Opt-in heuristic freshness and defaultTTL
// ---------------------------------------------------------------------------

test('heuristic: last-modified-only response is cached when opted in', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'last-modified': new Date(Date.now() - 3600e3).toUTCString(),
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()

  // Without the opt-in: not cached.
  const store1 = new SqliteCacheStore({ location: ':memory:' })
  const base1 = { origin: origin(server), path: '/', method: 'GET', headers: {} }
  await rawRequest(dispatch, { ...base1, cache: { store: store1 } })
  await rawRequest(dispatch, { ...base1, cache: { store: store1 } })
  t.equal(hits, 2, 'no heuristic caching by default')

  // With the opt-in: 10% of 1h ≈ 6 min of freshness.
  const store2 = new SqliteCacheStore({ location: ':memory:' })
  await rawRequest(dispatch, { ...base1, path: '/h', cache: { store: store2, heuristic: true } })
  await rawRequest(dispatch, { ...base1, path: '/h', cache: { store: store2, heuristic: true } })
  t.equal(hits, 3, 'heuristic freshness serves the second request from cache')
})

test('defaultTTL: response without any caching headers is cached when opted in', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store, defaultTTL: 60 },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'defaultTTL supplies the missing freshness lifetime')
})

// ---------------------------------------------------------------------------
// Header stripping (RFC 9111 §3.1, §5.2.2.4, §5.2.2.7)
// ---------------------------------------------------------------------------

test('stripping: hop-by-hop and Connection-listed headers are not stored', async (t) => {
  t.plan(4)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      connection: 'x-hop',
      'x-hop': 'per-connection',
      'keep-alive': 'timeout=5',
      'x-keep': 'stored',
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  const second = await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'served from cache')
  t.equal(second.headers['x-hop'], undefined, 'Connection-listed field stripped')
  t.equal(second.headers['keep-alive'], undefined, 'hop-by-hop field stripped')
  t.equal(second.headers['x-keep'], 'stored', 'end-to-end field preserved')
})

test('stripping: qualified no-cache="field" strips the field but stores the response', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60, no-cache="x-secret"',
      'x-secret': 'do-not-replay',
      'x-public': 'fine',
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  const second = await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'qualified no-cache does not prevent storage')
  t.equal(second.headers['x-secret'], undefined, 'listed field stripped from the stored entry')
  t.equal(second.headers['x-public'], 'fine', 'other fields preserved')
})

// ---------------------------------------------------------------------------
// Unsafe-method invalidation (RFC 9111 §4.4, undici PR #5514)
// ---------------------------------------------------------------------------

test('invalidation: successful POST invalidates the cached GET for the URI', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    if (req.method === 'GET') hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', headers: {}, cache: { store } }

  await rawRequest(dispatch, { ...base, method: 'GET' })
  await rawRequest(dispatch, { ...base, method: 'GET' })
  t.equal(hits, 1, 'GET cached')

  await rawRequest(dispatch, { ...base, method: 'POST' })
  await rawRequest(dispatch, { ...base, method: 'GET' })
  t.equal(hits, 2, 'POST invalidated the entry — GET went back to the origin')
})

test('invalidation: Location header target is invalidated too', async (t) => {
  t.plan(2)
  let bHits = 0
  const server = await startServer((req, res) => {
    if (req.url === '/b' && req.method === 'GET') {
      bHits++
      res.writeHead(200, { 'cache-control': 's-maxage=60' })
      res.end('b-body')
    } else {
      res.writeHead(201, { location: '/b' })
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = { origin: origin(server), headers: {}, cache: { store } }

  await rawRequest(dispatch, { ...base, path: '/b', method: 'GET' })
  await rawRequest(dispatch, { ...base, path: '/b', method: 'GET' })
  t.equal(bHits, 1, '/b cached')

  await rawRequest(dispatch, { ...base, path: '/a', method: 'POST' })
  await rawRequest(dispatch, { ...base, path: '/b', method: 'GET' })
  t.equal(bHits, 2, 'POST /a with Location: /b invalidated the cached /b')
})

test('invalidation: cross-origin Location is ignored (no poisoning)', async (t) => {
  t.plan(1)
  let bHits = 0
  const server = await startServer((req, res) => {
    if (req.url === '/b' && req.method === 'GET') {
      bHits++
      res.writeHead(200, { 'cache-control': 's-maxage=60' })
      res.end('b-body')
    } else {
      res.writeHead(201, { location: 'http://attacker.example/b' })
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = { origin: origin(server), headers: {}, cache: { store } }

  await rawRequest(dispatch, { ...base, path: '/b', method: 'GET' })
  await rawRequest(dispatch, { ...base, path: '/a', method: 'POST' })
  await rawRequest(dispatch, { ...base, path: '/b', method: 'GET' })
  t.equal(bHits, 1, 'cross-origin Location did not invalidate the same-path entry')
})

test('invalidation: failed (5xx) unsafe request does not invalidate', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    if (req.method === 'GET') {
      hits++
      res.writeHead(200, { 'cache-control': 's-maxage=60' })
      res.end('body')
    } else {
      res.writeHead(500)
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', headers: {}, cache: { store } }

  await rawRequest(dispatch, { ...base, method: 'GET' })
  await rawRequest(dispatch, { ...base, method: 'POST' })
  await rawRequest(dispatch, { ...base, method: 'GET' })
  t.equal(hits, 1, 'a 500 to the POST left the cached entry alone')
})

test('invalidation: OPTIONS is safe and does not invalidate', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    if (req.method === 'GET') {
      hits++
      res.writeHead(200, { 'cache-control': 's-maxage=60' })
      res.end('body')
    } else {
      res.writeHead(204)
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', headers: {}, cache: { store } }

  await rawRequest(dispatch, { ...base, method: 'GET' })
  await rawRequest(dispatch, { ...base, method: 'OPTIONS' })
  await rawRequest(dispatch, { ...base, method: 'GET' })
  t.equal(hits, 1, 'OPTIONS left the cached entry alone')
})

test('invalidation: array Location header uses the first value (review)', async (t) => {
  t.plan(2)
  let bHits = 0
  let cHits = 0
  const server = await startServer((req, res) => {
    if (req.method === 'GET') {
      if (req.url === '/b') bHits++
      if (req.url === '/c') cHits++
      res.writeHead(200, { 'cache-control': 's-maxage=60' })
      res.end('body')
    } else {
      res.setHeader('location', ['/b', '/c'])
      res.writeHead(201)
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = { origin: origin(server), headers: {}, cache: { store } }

  await rawRequest(dispatch, { ...base, path: '/b', method: 'GET' })
  await rawRequest(dispatch, { ...base, path: '/c', method: 'GET' })
  await rawRequest(dispatch, { ...base, path: '/a', method: 'POST' })

  await rawRequest(dispatch, { ...base, path: '/b', method: 'GET' })
  await rawRequest(dispatch, { ...base, path: '/c', method: 'GET' })
  t.equal(bHits, 2, 'first Location value (/b) was invalidated')
  t.equal(cHits, 1, 'second Location value (/c) untouched (first-value semantics)')
})

test('invalidation: POST with flat-array headers does not throw (review)', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    if (req.method === 'GET') hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', cache: { store } }

  await rawRequest(dispatch, { ...base, method: 'GET', headers: {} })
  // The legal undici flat name/value array form must not crash key building.
  const res = await rawRequest(dispatch, {
    ...base,
    method: 'POST',
    headers: ['content-type', 'text/plain'],
  })
  t.equal(res.statusCode, 200, 'POST with flat-array headers succeeds')

  await rawRequest(dispatch, { ...base, method: 'GET', headers: {} })
  t.equal(hits, 2, 'and still invalidated the cached GET')
})

// ---------------------------------------------------------------------------
// Parser regressions (review): restrictive forms must win, quoted lists must
// not leak directives
// ---------------------------------------------------------------------------

test('parser: qualified private/no-cache never clobbers the unqualified form (review)', async (t) => {
  const { parseCacheControl } = await import('../lib/utils.js')
  t.equal(
    parseCacheControl('private, private="x-a"').private,
    true,
    'unqualified private survives a later qualified form',
  )
  t.equal(
    parseCacheControl('no-cache="x-a", no-cache')['no-cache'],
    true,
    'a later unqualified no-cache overrides the qualified list',
  )
  t.strictSame(
    parseCacheControl('no-cache="a, max-stale, b"'),
    { 'no-cache': ['a', 'max-stale', 'b'] },
    'tokens inside a quoted field list never become live directives',
  )
  t.strictSame(
    parseCacheControl('no-cache="a, b" , max-age=5'),
    { 'no-cache': ['a', 'b'], 'max-age': 5 },
    'whitespace after the closing quote does not defeat the scan',
  )
  t.equal(
    parseCacheControl('no-cache="a, max-age=1')['no-cache'],
    true,
    'unterminated quoted list fails restrictive (unqualified)',
  )
  t.equal(
    parseCacheControl('no-cache="a, max-age=1')['max-age'],
    undefined,
    'fragments of the broken quoted list are not parsed as directives',
  )
  t.end()
})

// ---------------------------------------------------------------------------
// Query folded into the cache key (undici PR #5081)
// ---------------------------------------------------------------------------

test('query: opts.query is part of the cache key in standalone compositions', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end(req.url)
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const a = await rawRequest(dispatch, { ...base, query: { i: 0 } })
  const b = await rawRequest(dispatch, { ...base, query: { i: 1 } })
  t.not(a.body, b.body, 'different query strings are distinct entries')
  t.equal(hits, 2)

  await flush()
  const c = await rawRequest(dispatch, { ...base, query: { i: 0 } })
  t.equal(hits, 2, 'repeat query served from cache')
})

// ---------------------------------------------------------------------------
// Store: delete() and supersede
// ---------------------------------------------------------------------------

test('store: delete() removes all entries for the URI including pending batch inserts', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  const now = Date.now()
  const value = (body) => ({
    body: Buffer.from(body),
    start: 0,
    end: body.length,
    statusCode: 200,
    statusMessage: '',
    cachedAt: now,
    staleAt: now + 60e3,
    deleteAt: now + 120e3,
  })

  const getKey = { origin: 'https://example.com', method: 'GET', path: '/x' }
  const headKey = { origin: 'https://example.com', method: 'HEAD', path: '/x' }

  // One flushed entry and one pending batch entry.
  store.set(getKey, value('flushed'))
  await flush()
  store.set(headKey, { ...value(''), body: null, end: 0 })

  t.ok(store.get(getKey), 'GET entry present')
  t.ok(store.get(headKey), 'HEAD entry present (batch)')

  store.delete(getKey)

  t.equal(store.get(getKey), undefined, 'flushed entry deleted')
  t.equal(
    store.get(headKey),
    undefined,
    'pending batch entry for the URI dropped (no resurrection)',
  )

  await flush()
  t.equal(store.get(getKey), undefined, 'entry stays gone after the batch flushes')
  t.end()
})

test('store: re-caching a key supersedes the old row instead of accumulating', async (t) => {
  const dbPath = path.join(
    os.tmpdir(),
    `supersede-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
  )
  const store = new SqliteCacheStore({ location: dbPath })
  t.teardown(() => {
    store.close()
    fs.rmSync(dbPath, { force: true })
    fs.rmSync(`${dbPath}-wal`, { force: true })
    fs.rmSync(`${dbPath}-shm`, { force: true })
  })

  const key = { origin: 'https://example.com', method: 'GET', path: '/hot' }
  const value = (body, cachedAt) => ({
    body: Buffer.from(body),
    start: 0,
    end: body.length,
    statusCode: 200,
    statusMessage: '',
    cachedAt,
    staleAt: cachedAt + 60e3,
    deleteAt: cachedAt + 120e3,
  })

  const now = Date.now()
  store.set(key, value('one', now - 2))
  await flush()
  store.set(key, value('two-longer', now - 1))
  await flush()
  store.set(key, value('three', now))
  await flush()

  t.equal(store.get(key).body.toString(), 'three', 'newest entry served')

  const db = new DatabaseSync(dbPath, { readOnly: true })
  const { c } = db
    .prepare(`SELECT COUNT(*) c FROM cacheInterceptorV14 WHERE url = ?`)
    .get('https://example.com/hot')
  db.close()
  t.equal(c, 1, 'older rows for the representation were superseded')
  t.end()
})

test('store: distinct vary variants are not superseded by each other', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  const now = Date.now()
  const value = (body, vary) => ({
    body: Buffer.from(body),
    start: 0,
    end: body.length,
    statusCode: 200,
    statusMessage: '',
    vary,
    cachedAt: now,
    staleAt: now + 60e3,
    deleteAt: now + 120e3,
  })

  store.set(
    { origin: 'https://example.com', method: 'GET', path: '/v', headers: { a: '1' } },
    value('variant-1', { a: '1' }),
  )
  await flush()
  store.set(
    { origin: 'https://example.com', method: 'GET', path: '/v', headers: { a: '2' } },
    value('variant-2', { a: '2' }),
  )
  await flush()

  t.equal(
    store
      .get({ origin: 'https://example.com', method: 'GET', path: '/v', headers: { a: '1' } })
      .body.toString(),
    'variant-1',
    'first variant still served',
  )
  t.equal(
    store
      .get({ origin: 'https://example.com', method: 'GET', path: '/v', headers: { a: '2' } })
      .body.toString(),
    'variant-2',
    'second variant served',
  )
  t.end()
})
