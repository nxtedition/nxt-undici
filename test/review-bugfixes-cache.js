/* eslint-disable */
// End-to-end regression tests for cache interceptor bugs found during the
// in-depth review (HEAD caching/log spam, Age-aware freshness, Vary sentinel,
// 206-partial leakage).
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
// HEAD responses are cacheable and do NOT emit error-level log spam.
// Previously the store rejected the empty body against Content-Length and the
// failure was logged at error level on every cacheable HEAD response.
// ---------------------------------------------------------------------------

test('cache: HEAD response with Content-Length is cached without error logs', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      'content-type': 'text/plain',
      'content-length': '11',
    })
    res.end() // HEAD: no body delivered
  })
  t.teardown(server.close.bind(server))

  const errors = []
  const logger = {
    error: (...a) => errors.push(a),
    warn() {},
    debug() {},
    child() {
      return logger
    },
  }

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'HEAD',
    headers: {},
    cache: { store },
    logger,
  }

  await rawRequest(dispatch, opts)
  const second = await rawRequest(dispatch, opts)

  t.equal(hits, 1, 'HEAD response served from cache on the second request')
  t.equal(second.statusCode, 200)
  t.equal(errors.length, 0, 'no error-level log emitted for a cacheable HEAD response')
})

// ---------------------------------------------------------------------------
// Age-aware freshness: a response that arrives already stale (Age >= max-age)
// must NOT be cached.
// ---------------------------------------------------------------------------

test('cache: response with Age >= max-age is not cached (already stale)', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 'max-age=60',
      age: '100', // already older than its freshness lifetime
      'content-type': 'text/plain',
    })
    res.end('aged body')
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
  t.equal(hits, 2, 'stale-on-arrival response is re-fetched, not served from cache')
})

// ---------------------------------------------------------------------------
// Vary: a selecting header absent at store time must not act as a wildcard.
// ---------------------------------------------------------------------------

test('cache: Vary selecting header absent at store time does not match a later request that supplies it', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      vary: 'accept',
      'content-type': 'text/plain',
    })
    res.end('variant')
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

  // First request omits Accept → stored variant has accept absent.
  await rawRequest(dispatch, { ...base, headers: {} })
  // Second request supplies Accept → must MISS (absent != present).
  await rawRequest(dispatch, { ...base, headers: { accept: 'application/json' } })
  t.equal(hits, 2, 'request supplying accept must not reuse the no-accept variant')

  // Third request again omits Accept → hits cache (both absent).
  await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(hits, 2, 'request that also omits accept reuses the stored variant')
})

// ---------------------------------------------------------------------------
// 206 partial responses must not be served to a later plain (non-Range) GET.
// ---------------------------------------------------------------------------

test('cache: 206 partial is not served to a subsequent non-Range request', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    if (req.headers.range) {
      res.writeHead(206, {
        'cache-control': 's-maxage=60',
        'content-range': 'bytes 0-4/100',
        'content-type': 'text/plain',
      })
      res.end('hello')
    } else {
      res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
      res.end('the complete body')
    }
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

  // Cache a 206 partial starting at byte 0.
  const partial = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=0-4' } })
  t.equal(partial.statusCode, 206)

  // A plain GET must re-contact the origin and get the full body, not the 206.
  const full = await rawRequest(dispatch, { ...base, headers: {} })
  t.equal(full.body, 'the complete body', 'plain GET receives the full representation')
})
