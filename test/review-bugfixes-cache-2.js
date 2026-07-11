/* eslint-disable */
// End-to-end regression tests for cache interceptor bugs found during the
// second in-depth review (request directive handling, Vary '*' member,
// Set-Cookie, Trailer, invalid Content-Range, conditional header arrays,
// get/set key asymmetry, Age on cache hits).
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

function makeLogger(errors) {
  const logger = {
    error: (...a) => errors.push(a),
    warn() {},
    debug() {},
    child() {
      return logger
    },
  }
  return logger
}

// ---------------------------------------------------------------------------
// Request 'Cache-Control: max-age=0' must bypass the cache (the directive
// parses to the falsy number 0, which the old truthy check missed).
// ---------------------------------------------------------------------------

test('cache: request max-age=0 bypasses cache lookup', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
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

  await rawRequest(dispatch, { ...base, headers: {} })
  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'max-age=0' } })
  t.equal(hits, 2, 'max-age=0 must revalidate against the origin')

  // The entry from the first request is still there for unconditional requests.
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 2, 'plain request is still served from cache')
})

// ---------------------------------------------------------------------------
// 'min-fresh' / 'max-stale' are evaluated locally against the entry's
// freshness (RFC 9111 §5.2.1.3 / §5.2.1.2) instead of bypassing the cache.
// ---------------------------------------------------------------------------

test('cache: request min-fresh is evaluated against the entry freshness', async (t) => {
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

  await rawRequest(dispatch, { ...base, headers: {} })
  // ~60s of freshness left — comfortably more than 30s.
  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'min-fresh=30' } })
  t.equal(hits, 1, 'entry fresh for longer than min-fresh is served from cache')

  // Demands more remaining freshness than the entry can have — origin.
  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'min-fresh=120' } })
  t.equal(hits, 2, 'entry with less remaining freshness than min-fresh goes to origin')
})

test('cache: request max-stale still serves a fresh entry', async (t) => {
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
  const base = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    cache: { store },
  }

  await rawRequest(dispatch, { ...base, headers: {} })
  await rawRequest(dispatch, { ...base, headers: { 'cache-control': 'max-stale=30' } })
  t.equal(hits, 1, 'a fresh entry satisfies a max-stale request')
})

// ---------------------------------------------------------------------------
// A Vary list containing '*' among other members never matches (RFC 9111 §4.1)
// and must not be cached. The old code only caught the exact value '*'.
// ---------------------------------------------------------------------------

test('cache: Vary list containing * is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', vary: 'accept, *' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { accept: 'text/plain' },
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'vary: "accept, *" must never be served from cache')
})

// ---------------------------------------------------------------------------
// Responses carrying Set-Cookie must not be stored in a shared cache.
// ---------------------------------------------------------------------------

test('cache: response with Set-Cookie is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'set-cookie': 'session=abc' })
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
  t.equal(hits, 2, 'set-cookie response must not be replayed to other clients')
})

// ---------------------------------------------------------------------------
// 'Trailer' is the RFC 9110 field name announcing trailers; the old check only
// looked at the non-standard 'trailers'.
// ---------------------------------------------------------------------------

test('cache: response with Trailer header (RFC name) is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', trailer: 'x-checksum' })
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
  t.equal(hits, 2, 'responses announcing trailers via Trailer are not cached')
})

// ---------------------------------------------------------------------------
// Invalid Content-Range (end < start, or end > size) must not be cached and
// must not reach store.set (which would throw and emit error-level logs).
// ---------------------------------------------------------------------------

test('cache: content-range with end < start is not cached and emits no error logs', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(206, { 'cache-control': 's-maxage=60', 'content-range': 'bytes 5-2/10' })
    res.end('ab')
  })
  t.teardown(server.close.bind(server))

  const errors = []
  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
    logger: makeLogger(errors),
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'nonsensical content-range is never cached')
  t.equal(errors.length, 0, 'no error-level log from store.set validation')
})

test('cache: content-range exceeding the complete length is not cached', async (t) => {
  t.plan(1)
  let hits = 0
  const body = 'a'.repeat(100)
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(206, { 'cache-control': 's-maxage=60', 'content-range': 'bytes 0-99/50' })
    res.end(body)
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { range: 'bytes=0-99' },
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'content-range with end > complete-length is never cached')
})

// ---------------------------------------------------------------------------
// HEAD responses with Content-Range describe a body we never receive; storing
// them would fail the store's body-length validation and log at error level.
// ---------------------------------------------------------------------------

test('cache: HEAD response with Content-Range is not cached and emits no error logs', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(206, {
      'cache-control': 's-maxage=60',
      'content-range': 'bytes 0-4/100',
      'content-length': '5',
    })
    res.end() // HEAD: no body delivered
  })
  t.teardown(server.close.bind(server))

  const errors = []
  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'HEAD',
    headers: {},
    cache: { store },
    logger: makeLogger(errors),
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'HEAD + content-range is not cached')
  t.equal(errors.length, 0, 'no error-level log from store.set validation')
})

// ---------------------------------------------------------------------------
// Duplicated conditional headers arrive as arrays; the old code called
// String.prototype.split on them and threw synchronously inside dispatch. Per
// RFC 9110 §5.3 multiple field lines are equivalent to one comma-joined value,
// so the array is joined before matching (see #68): a matching validator among
// the lines yields a 304, and a non-matching list falls through to the stored
// fresh 200 — neither crashes, neither contacts the origin.
// ---------------------------------------------------------------------------

test('cache: If-None-Match as array is treated as one list, does not crash', async (t) => {
  t.plan(5)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', etag: '"abc"' })
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

  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 1)

  // A matching validator among the array lines yields a 304 from cache.
  const matched = await rawRequest(dispatch, {
    ...base,
    headers: { 'if-none-match': ['"abc"', '"def"'] },
  })
  t.equal(matched.statusCode, 304, 'matching etag among multiple lines returns 304')
  t.equal(hits, 1, 'matching array validator is served from cache without contacting origin')

  // A non-matching array on a fresh entry falls through to the stored 200.
  const missed = await rawRequest(dispatch, {
    ...base,
    headers: { 'if-none-match': ['"nope"', '"def"'] },
  })
  t.equal(missed.statusCode, 200, 'non-matching array serves the fresh stored 200')
  t.equal(hits, 1, 'non-matching array does not contact the origin')
})

test('cache: caller preconditions are ignored for a fresh cached redirect', async (t) => {
  t.plan(5)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(307, {
      'cache-control': 'max-age=60',
      etag: '"redirect-v1"',
      location: '/target',
    })
    res.end('redirect-body')
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

  await rawRequest(dispatch, { ...base, headers: {} })
  await new Promise((resolve) => setImmediate(resolve))
  const result = await rawRequest(dispatch, {
    ...base,
    headers: { 'if-none-match': '"redirect-v1"' },
  })

  t.equal(result.statusCode, 307, 'matching precondition did not synthesize a 304')
  t.equal(result.headers.location, '/target', 'stored redirect metadata was preserved')
  t.equal(result.headers.etag, '"redirect-v1"', 'redirect validator was preserved')
  t.equal(result.body, 'redirect-body', 'stored redirect body was served normally')
  t.equal(hits, 1, 'fresh redirect came from the cache')
})

// ---------------------------------------------------------------------------
// get/set key asymmetry: the set path normalized the key via makeKey
// (origin.toString()) while the get path used raw opts, so a URL-object origin
// could never produce a cache hit.
// ---------------------------------------------------------------------------

test('cache: URL object origin hits the cache on the second request', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const errors = []
  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: new URL(`http://0.0.0.0:${server.address().port}`),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
    logger: makeLogger(errors),
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'second request with a URL origin is served from cache')
  t.equal(errors.length, 0, 'no error-level log from key validation on the get path')
})

// ---------------------------------------------------------------------------
// RFC 9111 §5.1: responses served from cache must carry an Age header.
// ---------------------------------------------------------------------------

test('cache: cache hit carries an Age header', async (t) => {
  t.plan(3)
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
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  const second = await rawRequest(dispatch, opts)
  t.equal(hits, 1)
  t.ok(second.headers.age != null, 'age header is present on the cache hit')
  t.ok(Number(second.headers.age) >= 0, 'age is a non-negative number of seconds')
})

test('cache: Age accumulates on top of the age the response arrived with', async (t) => {
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
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  const second = await rawRequest(dispatch, opts)
  t.equal(hits, 1)
  t.ok(Number(second.headers.age) >= 5, 'served age includes the age it arrived with')
})
