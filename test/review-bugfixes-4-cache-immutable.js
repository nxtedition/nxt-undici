// Regression tests for the RFC 8246 'immutable' TTL bug: immutable marks the
// body as unchanging during the freshness lifetime — it does not define or
// extend that lifetime. An explicit s-maxage/max-age must win; immutable only
// supplies a long default TTL when no explicit lifetime is present.
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
  const entry = store.get(undici.util.cache.makeCacheKey(opts))
  t.equal(entry.staleAt - entry.cachedAt, 5000, 'freshness is max-age, not immutable')
})

test('cache: immutable alone still caches with a long default TTL', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'immutable', 'content-type': 'text/plain' })
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
  t.equal(hits, 1, 'immutable without explicit lifetime is still cached')

  // The ~1 year immutable default is capped by maxEntryTTL (default 30 days).
  const entry = store.get(undici.util.cache.makeCacheKey(opts))
  t.equal(entry.deleteAt - entry.cachedAt, 30 * 24 * 3600 * 1000, 'TTL capped at maxEntryTTL')
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

  const entry = store.get(undici.util.cache.makeCacheKey(opts))
  t.equal(
    entry.staleAt - entry.cachedAt,
    60 * 1000,
    's-maxage=60 sets the freshness, not immutable',
  )
})
