/* eslint-disable */
// `origins` whitelist option (undici PR #4739): the cache interceptor only
// caches (stores/serves/invalidates) requests whose origin is permitted by the
// configured whitelist. A matching origin is cached (second request is a hit);
// a non-matching origin bypasses the cache (second request hits the origin
// again). Ported from undici's origins-option tests, adapted to the dispatch
// API of this fork.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

async function startServer() {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('body')
  })
  server.listen(0)
  await once(server, 'listening')
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    hits: () => hits,
  }
}

function rawRequest(dispatch, opts) {
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

const flush = () => new Promise((resolve) => setImmediate(resolve))

// Issues the same GET twice through a fresh store and reports how many times
// the origin was contacted: 1 => the second was a cache hit (cached), 2 => the
// cache was bypassed (not cached). `opts.origin` is the live server, so it
// drives both the whitelist check and where the Agent connects.
async function originHitsFor(origins) {
  const srv = await startServer()
  try {
    const store = new SqliteCacheStore({ location: ':memory:' })
    const dispatch = compose(new undici.Agent(), interceptors.cache({ origins }))
    const opts = {
      origin: srv.origin,
      path: '/',
      method: 'GET',
      headers: {},
      cache: { store },
    }
    await rawRequest(dispatch, opts)
    await flush()
    await rawRequest(dispatch, opts)
    return srv.hits()
  } finally {
    srv.server.close()
  }
}

test('origins: caches when the request origin matches a string entry', async (t) => {
  t.plan(1)
  const srv = await startServer()
  t.teardown(() => srv.server.close())
  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = compose(new undici.Agent(), interceptors.cache({ origins: [srv.origin] }))
  const opts = { origin: srv.origin, path: '/', method: 'GET', headers: {}, cache: { store } }
  await rawRequest(dispatch, opts)
  await flush()
  await rawRequest(dispatch, opts)
  t.equal(srv.hits(), 1, 'second request served from cache')
})

test('origins: skips caching when the request origin does not match a string entry', async (t) => {
  t.plan(1)
  t.equal(await originHitsFor(['http://example.com']), 2, 'both requests hit the origin')
})

test('origins: caches when the request origin matches a RegExp entry', async (t) => {
  t.plan(1)
  t.equal(await originHitsFor([/127\.0\.0\.1/]), 1, 'RegExp match enables caching')
})

test('origins: skips caching when the request origin does not match a RegExp entry', async (t) => {
  t.plan(1)
  t.equal(await originHitsFor([/example\.com/]), 2, 'RegExp miss bypasses the cache')
})

test('origins: a global-flag RegExp matches consistently across requests (no lastIndex drift)', async (t) => {
  t.plan(1)
  // With a `g` flag, RegExp#test is stateful: without a lastIndex reset the
  // second request would test from mid-string, fail to match, and bypass the
  // cache — so this hits the origin twice unless matching is stateless.
  t.equal(await originHitsFor([/127\.0\.0\.1/g]), 1, 'global RegExp still enables caching on reuse')
})

test('origins: caches when the origin matches any entry in a mixed array', async (t) => {
  t.plan(1)
  t.equal(
    await originHitsFor(['http://other.example', /127\.0\.0\.1/]),
    1,
    'any match enables caching',
  )
})

test('origins: undefined caches every origin (default, backward compatible)', async (t) => {
  t.plan(1)
  t.equal(await originHitsFor(undefined), 1, 'no whitelist => caches as before')
})

test('origins: an empty array caches nothing', async (t) => {
  t.plan(1)
  t.equal(await originHitsFor([]), 2, 'empty whitelist matches no origin')
})

test('origins: string matching is case-insensitive', async (t) => {
  t.plan(1)
  const srv = await startServer()
  t.teardown(() => srv.server.close())
  const store = new SqliteCacheStore({ location: ':memory:' })
  // Whitelist the origin upper-cased; the request origin is lower-case.
  const dispatch = compose(
    new undici.Agent(),
    interceptors.cache({ origins: [srv.origin.toUpperCase()] }),
  )
  const opts = { origin: srv.origin, path: '/', method: 'GET', headers: {}, cache: { store } }
  await rawRequest(dispatch, opts)
  await flush()
  await rawRequest(dispatch, opts)
  t.equal(srv.hits(), 1, 'case-insensitive string match enables caching')
})

test('origins: throws TypeError when not an array', async (t) => {
  t.plan(2)
  t.throws(() => interceptors.cache({ origins: 'http://example.com' }), TypeError)
  t.throws(() => interceptors.cache({ origins: 123 }), TypeError)
})

test('origins: throws TypeError when an array entry is neither string nor RegExp', async (t) => {
  t.plan(2)
  t.throws(() => interceptors.cache({ origins: [123] }), TypeError)
  t.throws(() => interceptors.cache({ origins: [{}] }), TypeError)
})

// ---------------------------------------------------------------------------
// Cache keys on the LOGICAL origin, not the resolved IP: a downstream
// (inner-of-cache) origin→IP rewrite — as the dns interceptor does, and as
// DNS round-robin would vary per request — must not fragment the cache.
// ---------------------------------------------------------------------------

test('cache keys on the logical origin; a rotating downstream IP does not break caching', async (t) => {
  t.plan(4)

  // Base "network": serves a cacheable response and counts how often the ORIGIN
  // was actually contacted (i.e. cache misses).
  let originHits = 0
  const base = (opts, handler) => {
    originHits++
    handler.onConnect(() => {})
    handler.onHeaders(
      200,
      { 'content-type': 'text/plain', 'cache-control': 'max-age=60' },
      () => {},
    )
    handler.onData(Buffer.from('payload'))
    handler.onComplete({})
    return true
  }

  // "dns round-robin", placed INNER of the cache (runs after it): rewrites the
  // origin to a different IP on every call. If the cache keyed on the rewritten
  // origin, every request would miss.
  let rr = 0
  const rotatingDns = (dispatch) => (opts, handler) =>
    dispatch({ ...opts, origin: `http://10.0.0.${++rr}:80` }, handler)

  // Record the origin the cache actually keys on.
  const inner = new SqliteCacheStore({ location: ':memory:' })
  const keyed = []
  const store = {
    maxEntrySize: inner.maxEntrySize,
    get(key) {
      keyed.push(key.origin)
      return inner.get(key)
    },
    set(key, val) {
      return inner.set(key, val)
    },
    delete(key) {
      return inner.delete(key)
    },
  }

  // cache OUTER of rotatingDns — the default-pipeline order (cache before dns).
  const dispatch = compose(base, rotatingDns, interceptors.cache())
  const opts = { origin: 'http://api.example.com', path: '/thing', method: 'GET', cache: { store } }

  await rawRequest(dispatch, opts)
  await flush()
  const second = await rawRequest(dispatch, opts)

  t.equal(second.body, 'payload', 'second request served from cache')
  t.equal(originHits, 1, 'the rotating downstream IP did not cause a second origin hit')
  t.same(
    [...new Set(keyed)],
    ['http://api.example.com'],
    'cache keyed on the logical origin, never the rotating 10.0.0.x IP',
  )
  t.equal(rr, 1, 'the origin→IP rewrite ran once (miss only); the hit never reached it')
})
