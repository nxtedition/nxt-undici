// Regression tests for RFC 8246 'immutable': it marks the body as unchanging
// during the freshness lifetime — it neither defines nor extends that lifetime
// (§2), so it is NOT a freshness source. An explicit s-maxage/max-age sets the
// lifetime; immutable alone (no explicit/heuristic/default lifetime) is not
// cacheable.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import { makeKey } from '../lib/interceptor/cache/store.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.cache())
}

function rawRequest(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc) {
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

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

test('cache: immutable does not override explicit max-age (expires on schedule)', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // max-age=5 rather than 1: node's Date header is second-truncated, so the
    // corrected initial age (RFC 9111 §4.2.3) can legitimately read 1s at
    // receipt — a 1s lifetime would make storability itself racy.
    res.writeHead(200, { 'cache-control': 'max-age=5, immutable', 'content-type': 'text/plain' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
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
  t.equal(hits, 1, 'served from cache within the max-age window')

  // Expiry-on-schedule is asserted from the stored entry instead of sleeping
  // past the TTL: max-age bounds the freshness lifetime, immutable does not
  // extend it.
  const entry = store.get(makeKey(opts))
  t.equal(entry.staleAt - entry.cachedAt, 5000, 'freshness is max-age, not immutable')
})

test('cache: immutable alone is not cached (immutable is not a freshness source)', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'immutable', 'content-type': 'text/plain' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
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
  // RFC 8246 §2: immutable does not define a lifetime, so with no
  // max-age/s-maxage/Expires (and no heuristic/defaultTTL configured) the
  // response has no freshness and is not stored — the origin is hit each time.
  t.equal(hits, 2, 'immutable without a lifetime is not cached')

  const entry = store.get(makeKey(opts))
  t.equal(entry, undefined, 'nothing stored for immutable-only')
})

test('cache: explicit s-maxage wins over immutable', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60, immutable', 'content-type': 'text/plain' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
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
  t.equal(hits, 1, 'served from cache within the s-maxage window')

  const entry = store.get(makeKey(opts))
  t.equal(
    entry.staleAt - entry.cachedAt,
    60 * 1000,
    's-maxage=60 sets the freshness, not immutable',
  )
})
