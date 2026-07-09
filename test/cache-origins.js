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
// cache was bypassed (not cached).
async function originHitsFor(origins, { originOverride } = {}) {
  const srv = await startServer()
  try {
    const store = new SqliteCacheStore({ location: ':memory:' })
    const dispatch = compose(new undici.Agent(), interceptors.cache({ origins }))
    // opts.origin drives both the interceptor's whitelist check and the key;
    // an override lets a test exercise case-insensitivity while still routing
    // to the live server (which the Agent reaches via the real origin).
    const opts = {
      origin: originOverride ?? srv.origin,
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
