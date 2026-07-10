/* eslint-disable */
// Coverage for the gaps flagged by the July 2026 cache deep review (issue #76),
// behaviors that were manually verified but lacked automated protection:
//   1. interceptor entry request-gating — OPTIONS/TRACE are never cached and
//      never invalidate; opts.upgrade bypasses the cache; the origins whitelist
//      gates unsafe-method invalidation.
//   2. 307 caching — one of only three storable statuses (200/206/307), with no
//      direct test.
//   3. backgroundRefresh state stripping — the refresh must drop the caller's
//      body and signal so a caller abort after being served stale cannot kill
//      the shared refresh.
// Kept lightweight (no sleeps; stale entries seeded via a fake store / direct
// call) because the full suite flakes under parallel load.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import { backgroundRefresh } from '../lib/interceptor/cache/revalidation.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDispatch(cacheOpts) {
  return compose(new undici.Agent(), interceptors.cache(cacheOpts))
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

// ---------------------------------------------------------------------------
// 1. Interceptor entry request-gating
// ---------------------------------------------------------------------------

test('gating: TRACE is safe — never cached and does not invalidate (RFC 9110 §9.2.1)', async (t) => {
  t.plan(3)
  let getHits = 0
  let traceHits = 0
  const server = await startServer((req, res) => {
    if (req.method === 'GET') {
      getHits++
      res.writeHead(200, { 'cache-control': 's-maxage=60' })
      res.end('body')
    } else {
      traceHits++
      res.writeHead(200, { 'cache-control': 's-maxage=60' })
      res.end('trace-body')
    }
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', headers: {}, cache: { store } }

  await rawRequest(dispatch, { ...base, method: 'GET' })
  await rawRequest(dispatch, { ...base, method: 'GET' })
  t.equal(getHits, 1, 'GET is cached')

  // A TRACE response is never stored (a second TRACE reaches the origin again)…
  await rawRequest(dispatch, { ...base, method: 'TRACE' })
  await rawRequest(dispatch, { ...base, method: 'TRACE' })
  t.equal(traceHits, 2, 'TRACE is never served from cache')

  // …and TRACE must not invalidate the cached GET.
  await rawRequest(dispatch, { ...base, method: 'GET' })
  t.equal(getHits, 1, 'TRACE left the cached GET untouched')
})

test('gating: OPTIONS response is never stored', async (t) => {
  t.plan(1)
  let optionsHits = 0
  const server = await startServer((req, res) => {
    optionsHits++
    // Even with an explicit freshness lifetime the OPTIONS response is a
    // never-storable method and must not be reused.
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('options-body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const base = {
    origin: origin(server),
    path: '/',
    headers: {},
    cache: { store },
    method: 'OPTIONS',
  }

  await rawRequest(dispatch, base)
  await rawRequest(dispatch, base)
  t.equal(optionsHits, 2, 'each OPTIONS reached the origin — none was served from cache')
})

test('gating: opts.upgrade bypasses the cache entirely (store never consulted)', (t) => {
  t.plan(3)
  let storeTouched = false
  const store = {
    get() {
      storeTouched = true
      throw new Error('store.get must not be called for an upgrade request')
    },
    set() {
      storeTouched = true
    },
    delete() {
      storeTouched = true
    },
  }

  let dispatchedOpts = null
  const spyDispatch = (opts) => {
    dispatchedOpts = opts
  }
  const wrapped = interceptors.cache()(spyDispatch)

  wrapped(
    {
      origin: 'http://upgrade.local',
      path: '/',
      method: 'GET',
      headers: {},
      cache: { store },
      upgrade: 'websocket',
    },
    { onConnect() {}, onHeaders: () => true, onData: () => true, onComplete() {}, onError() {} },
  )

  t.ok(dispatchedOpts, 'the request was dispatched straight through')
  t.equal(dispatchedOpts.upgrade, 'websocket', 'the upgrade opt is preserved unchanged')
  t.notOk(storeTouched, 'the cache store was never consulted')
})

test('gating: origins whitelist gates unsafe-method invalidation', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))
  const requestOrigin = origin(server)

  // A store that records the keys it was asked to delete — the observable
  // signal of an invalidation actually running.
  const makeStore = () => {
    const deletes = []
    return {
      deletes,
      get: () => undefined,
      set: () => {},
      delete: (key) => {
        deletes.push(key)
      },
    }
  }

  // Non-whitelisted origin: the entry gate short-circuits before the unsafe
  // method branch, so no invalidation is attempted.
  const blockedStore = makeStore()
  const blockedDispatch = makeDispatch({ origins: ['http://not-the-origin.local'] })
  await rawRequest(blockedDispatch, {
    origin: requestOrigin,
    path: '/',
    method: 'POST',
    headers: {},
    cache: { store: blockedStore },
  })
  t.equal(blockedStore.deletes.length, 0, 'a non-whitelisted origin never invalidates')

  // Whitelisted origin: the same POST reaches the invalidation handler.
  const allowedStore = makeStore()
  const allowedDispatch = makeDispatch({ origins: [requestOrigin] })
  await rawRequest(allowedDispatch, {
    origin: requestOrigin,
    path: '/',
    method: 'POST',
    headers: {},
    cache: { store: allowedStore },
  })
  t.ok(allowedStore.deletes.length > 0, 'a whitelisted origin still invalidates')
})

// ---------------------------------------------------------------------------
// 2. 307 caching (one of the three storable statuses)
// ---------------------------------------------------------------------------

test('307: a 307 with explicit freshness is stored and served from cache', async (t) => {
  t.plan(4)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(307, { location: '/elsewhere', 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const base = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, base)
  t.equal(first.statusCode, 307, 'the origin returned a 307')

  const second = await rawRequest(dispatch, base)
  t.equal(hits, 1, 'the second request was served from cache — no origin hit')
  t.equal(second.statusCode, 307, 'the cached status is the 307')
  t.equal(second.headers.location, '/elsewhere', 'the Location header is preserved')
})

test('307: without explicit freshness a 307 is not cached (no heuristic for redirects)', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // Last-Modified would seed a heuristic lifetime for a 200, but 307 is not
    // eligible for cache-invented freshness — only 200 is.
    res.writeHead(307, { location: '/elsewhere', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  // Opt into heuristics + a defaultTTL to prove neither rescues a bare 307.
  const dispatch = makeDispatch()
  const base = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store, heuristic: true, defaultTTL: 60 },
  }

  await rawRequest(dispatch, base)
  const second = await rawRequest(dispatch, base)
  t.equal(hits, 2, 'the 307 was refetched — heuristic/defaultTTL do not apply to it')
  t.equal(second.statusCode, 307, 'still a 307')
})

// ---------------------------------------------------------------------------
// 3. backgroundRefresh state stripping
// ---------------------------------------------------------------------------

test('backgroundRefresh: strips the caller body and signal from the refresh dispatch', (t) => {
  t.plan(5)

  let bgOpts = null
  const spyDispatch = (opts) => {
    bgOpts = opts
  }

  const store = {}
  const key = { method: 'GET', origin: 'http://bg.local', path: '/', headers: {} }
  const entry = { cachedAt: Date.now(), etag: '"v1"' }

  // The caller supplied a body and an abort signal — both are caller-owned
  // request state that must not ride along on the shared refresh.
  const ac = new AbortController()
  const opts = {
    origin: 'http://bg.local',
    path: '/',
    method: 'GET',
    headers: {},
    cache: {},
    body: 'caller-body',
    signal: ac.signal,
  }

  backgroundRefresh(spyDispatch, opts, key, store, entry)

  t.ok(bgOpts, 'the refresh was dispatched')
  t.equal(bgOpts.body, null, 'the caller body was stripped')
  t.equal(bgOpts.signal, undefined, 'the caller signal was stripped')

  // Aborting the caller's signal after the fact must not reach the refresh:
  // it never received the signal, so it has nothing to react to.
  ac.abort()
  t.equal(bgOpts.signal, undefined, 'a later caller abort does not attach to the refresh')
  t.equal(bgOpts.headers['if-none-match'], '"v1"', 'the refresh is still conditional on the etag')
})
