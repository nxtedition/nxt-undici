import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'tap'
import undici from '@nxtedition/undici'
import {
  dispatch as nxtDispatch,
  getDispatcherStats,
  getGlobalDispatcherStats,
  interceptors,
  SqliteCacheStore,
} from '../lib/index.js'

function rawRequest(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    const chunks = []
    dispatch(opts, {
      onConnect() {},
      onHeaders(status) {
        statusCode = status
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.from(chunk))
      },
      onComplete() {
        resolve({ statusCode, body: Buffer.concat(chunks).toString() })
      },
      onError: reject,
    })
  })
}

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

function makeKey(path = '/') {
  return { origin: 'https://example.test', method: 'GET', path }
}

function makeValue() {
  const now = Date.now()
  return {
    body: Buffer.from('cached'),
    start: 0,
    end: 6,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 60e3,
    deleteAt: now + 120e3,
  }
}

test('cache interceptor exposes zero-cost disabled and cache-configured bypass stats', (t) => {
  const cache = interceptors.cache()
  let dispatched = 0
  const dispatch = cache(() => {
    dispatched++
    return true
  })

  dispatch({ cache: false }, {})
  dispatch({ cache: true, upgrade: 'websocket' }, {})

  t.equal(dispatched, 2)
  t.same(cache.stats(), {
    hits: 0,
    misses: 0,
    revalidations: 0,
    bypasses: 1,
    hitRate: 0,
  })
  t.end()
})

test('cache interceptor reports useful hit, miss, revalidation, and store totals', async (t) => {
  let requests = 0
  const server = await startServer((req, res) => {
    requests++
    if (req.url === '/revalidate' && req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { etag: '"v1"', 'cache-control': 's-maxage=0' })
      res.end()
      return
    }
    const revalidate = req.url === '/revalidate'
    res.writeHead(200, {
      etag: '"v1"',
      'cache-control': revalidate ? 's-maxage=0' : 's-maxage=60',
    })
    res.end(revalidate ? 'validate' : 'fresh')
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  const agent = new undici.Agent()
  const cache = interceptors.cache()
  const dispatch = cache(agent.dispatch.bind(agent))
  t.teardown(() => store.close())
  t.teardown(() => agent.close())

  const origin = `http://127.0.0.1:${server.address().port}`
  const opts = (path) => ({ origin, path, method: 'GET', headers: {}, cache: { store } })

  await rawRequest(dispatch, opts('/fresh'))
  await rawRequest(dispatch, opts('/fresh'))
  await rawRequest(dispatch, opts('/revalidate'))
  await rawRequest(dispatch, opts('/revalidate'))

  t.equal(requests, 3, 'one fresh response is served without upstream I/O')
  t.match(cache.stats(), {
    hits: 1,
    misses: 3,
    revalidations: 1,
    bypasses: 0,
    hitRate: 0.25,
    store: {
      stores: 1,
      gets: 4,
      hits: 2,
      sets: 3,
    },
  })
})

test('SqliteCacheStore stats expose operations, queue depth, and capacity', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:', maxSize: 1024 * 1024 })

  store.set(makeKey(), makeValue())
  t.match(store.stats, { sets: 1, writes: 0, pending: 1, maxSize: 1024 * 1024 })

  await new Promise((resolve) => setImmediate(resolve))
  t.equal(store.get(makeKey()).body.toString(), 'cached')
  t.equal(store.get(makeKey('/missing')), undefined)
  store.delete(makeKey())
  store.gc()
  store.clear()

  t.match(store.stats, {
    gets: 2,
    hits: 1,
    hitRate: 0.5,
    writes: 1,
    flushes: 1,
    deletes: 1,
    gcs: 1,
    clears: 1,
    pending: 0,
    errors: 0,
  })
  t.ok(store.stats.size > 0)
  t.ok(store.stats.usedSize > 0)

  store.close()
  t.equal(store.stats.closed, true)
})

test('wrapped dispatcher stats globally include every interceptor snapshot', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('global')
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  const agent = new undici.Agent()
  t.teardown(() => store.close())
  t.teardown(() => agent.close())

  const origin = `http://127.0.0.1:${server.address().port}`
  const dispatch = (opts, handler) => nxtDispatch(agent, opts, handler)
  const opts = { origin, path: '/', method: 'GET', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)

  const stats = getGlobalDispatcherStats()
  t.match(stats.cache, { hits: 1, misses: 1, hitRate: 0.5 })
  t.match(
    stats.pressure.find((entry) => entry.origin === origin),
    {
      pending: 0,
      running: 0,
      completed: 1,
    },
  )
  t.same(stats.priority, [])
  t.same(stats.redirect, { followed: 0 })
  t.same(stats.dns, {
    hits: 0,
    misses: 0,
    negativeHits: 0,
    lookups: 0,
    refreshes: 0,
    errors: 0,
    evictions: 0,
    pending: 0,
  })
  t.match(stats.lookup, { lookups: 2, errors: 0, pending: 0 })
})

test('wrapped dispatcher stats can be read for one dispatcher', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('dispatcher')
  })
  t.teardown(() => server.close())

  const firstStore = new SqliteCacheStore({ location: ':memory:' })
  const secondStore = new SqliteCacheStore({ location: ':memory:' })
  const firstAgent = new undici.Agent()
  const secondAgent = new undici.Agent()
  t.teardown(() => firstStore.close())
  t.teardown(() => secondStore.close())
  t.teardown(() => firstAgent.close())
  t.teardown(() => secondAgent.close())

  t.match(getDispatcherStats(firstAgent), {
    cache: { hits: 0, misses: 0 },
    pressure: [],
  })

  const origin = `http://127.0.0.1:${server.address().port}`
  const request = (agent, store, path) =>
    rawRequest((opts, handler) => nxtDispatch(agent, opts, handler), {
      origin,
      path,
      method: 'GET',
      headers: {},
      cache: { store },
    })

  await request(firstAgent, firstStore, '/first')
  await request(firstAgent, firstStore, '/first')
  await request(secondAgent, secondStore, '/second')

  t.match(getDispatcherStats(firstAgent), {
    cache: { hits: 1, misses: 1, hitRate: 0.5, store: { stores: 1 } },
    pressure: [{ origin, completed: 1 }],
  })
  t.match(getDispatcherStats(secondAgent), {
    cache: { hits: 0, misses: 1, hitRate: 0, store: { stores: 1 } },
    pressure: [{ origin, completed: 1 }],
  })
})

test('global and per-dispatcher stats forward priority, DNS, redirect, and lookup state', async (t) => {
  const calls = []
  const dispatcher = {
    dispatch(opts, handler) {
      calls.push({ opts, handler })
    },
  }
  const origin = 'http://stats.test'
  const response = rawRequest((opts, handler) => nxtDispatch(dispatcher, opts, handler), {
    origin,
    path: '/start',
    method: 'GET',
    headers: {},
    priority: 'high',
    follow: 1,
    retry: 0,
    dns: {
      ttl: 60e3,
      lookup(_hostname, _opts, callback) {
        callback(null, [{ address: '127.0.0.1', family: 4 }])
      },
    },
  })

  await new Promise((resolve) => setImmediate(resolve))
  t.equal(calls.length, 1)

  let stats = getGlobalDispatcherStats()
  t.match(
    stats.priority.find((entry) => entry.origin === origin),
    { running: 1, pending: 0 },
  )
  t.ok(stats.dns.misses >= 1)
  t.ok(stats.dns.lookups >= 1)
  t.ok(stats.lookup.lookups >= 1)
  let dispatcherStats = getDispatcherStats(dispatcher)
  t.match(
    dispatcherStats.priority.find((entry) => entry.origin === origin),
    { running: 1, pending: 0 },
  )
  t.ok(dispatcherStats.dns.misses >= 1)
  t.ok(dispatcherStats.dns.lookups >= 1)
  t.ok(dispatcherStats.lookup.lookups >= 1)

  calls[0].handler.onConnect(() => {})
  calls[0].handler.onHeaders(302, { location: '/next' }, () => {})
  calls[0].handler.onComplete([])

  await new Promise((resolve) => setImmediate(resolve))
  t.equal(calls.length, 2)
  stats = getGlobalDispatcherStats()
  t.ok(stats.redirect.followed >= 1)
  t.ok(stats.dns.hits >= 1)
  t.match(
    stats.priority.find((entry) => entry.origin === origin),
    { running: 1, pending: 0 },
  )
  dispatcherStats = getDispatcherStats(dispatcher)
  t.ok(dispatcherStats.redirect.followed >= 1)
  t.ok(dispatcherStats.dns.hits >= 1)

  calls[1].handler.onConnect(() => {})
  calls[1].handler.onHeaders(200, {}, () => {})
  calls[1].handler.onComplete([])
  await response
})
