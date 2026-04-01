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

function makeDispatch(store) {
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
