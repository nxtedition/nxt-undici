// Issue #67: extend storability beyond 200/206/307. A shared cache should
// store permanent redirects (301/308) and negative responses (404/410) when
// the origin sends EXPLICIT freshness (max-age/s-maxage/Expires), so a media
// backend stops refetching them on every request. The cache-INVENTED lifetimes
// (heuristic from Last-Modified, configured defaultTTL) stay 200-only, so these
// statuses are never cached on the cache's own initiative. (Restricting the
// heuristic to 200 is a conservative policy — RFC 9110 §15.1 also lists
// 301/308/404/410 as heuristically cacheable — not a protocol requirement.)
//
// Uses the standalone interceptors.cache() composition (no redirect / no
// response-error interceptor) so a cached 301/308 is returned verbatim rather
// than followed, and a cached 404/410 is returned rather than thrown.
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
        return true
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

const CASES = [
  { status: 301, extra: { location: '/moved' }, body: 'moved permanently' },
  { status: 308, extra: { location: '/moved' }, body: 'permanent redirect' },
  { status: 404, extra: {}, body: 'not found' },
  { status: 410, extra: {}, body: 'gone' },
]

for (const { status, extra, body } of CASES) {
  test(`storability: ${status} with explicit max-age is cached and served`, async (t) => {
    let hits = 0
    const server = await startServer((req, res) => {
      hits++
      res.writeHead(status, { 'cache-control': 'max-age=60', ...extra })
      res.end(body)
    })
    t.teardown(server.close.bind(server))

    const store = new SqliteCacheStore({ location: ':memory:' })
    t.teardown(() => store.close())
    const dispatch = makeDispatch()
    const opts = {
      origin: origin(server),
      method: 'GET',
      path: '/r',
      headers: {},
      cache: { store },
    }

    const miss = await rawRequest(dispatch, opts)
    t.equal(miss.statusCode, status, 'miss: origin status')
    t.equal(miss.body, body)
    await flush()

    const hit = await rawRequest(dispatch, opts)
    t.equal(hits, 1, `${status} served from cache on the second request`)
    t.equal(hit.statusCode, status, 'hit: same status')
    t.equal(hit.body, body, 'hit: same body')
    t.ok(Number(hit.headers.age) >= 0, 'hit carries an Age header')
    if (extra.location) {
      t.equal(hit.headers.location, extra.location, 'redirect Location preserved')
    }
    t.end()
  })
}

test('storability: non-200 statuses are NOT heuristically cached (200 is)', async (t) => {
  // heuristic is enabled AND a Last-Modified is present: a 200 gets heuristic
  // freshness and caches, but 301/308/404/410 must not — the invented
  // lifetimes are 200-only, so without explicit freshness they fall through
  // to the 'no-lifetime' skip.
  const lastModified = new Date(Date.now() - 3600e3).toUTCString()
  for (const { status, extra } of [{ status: 200, extra: {} }, ...CASES]) {
    let hits = 0
    const server = await startServer((req, res) => {
      hits++
      res.writeHead(status, { 'last-modified': lastModified, ...extra })
      res.end('x')
    })
    // Register teardowns immediately so a throwing assertion below can't leak
    // the server/store into later iterations or tests.
    t.teardown(server.close.bind(server))
    const store = new SqliteCacheStore({ location: ':memory:' })
    t.teardown(() => store.close())
    const dispatch = makeDispatch()
    const opts = {
      origin: origin(server),
      method: 'GET',
      path: '/h',
      headers: {},
      cache: { store, heuristic: true },
    }

    await rawRequest(dispatch, opts)
    await flush()
    await rawRequest(dispatch, opts)

    if (status === 200) {
      t.equal(hits, 1, '200 IS heuristically cached (control)')
    } else {
      t.equal(hits, 2, `${status} is not heuristically cached (no explicit freshness)`)
    }
  }
  t.end()
})

test('storability: a status this cache declines (500) is not stored even with explicit freshness', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // 500 is RFC-cacheable given freshness (§15.1), but outside this cache's
    // stored subset — so even WITH explicit freshness it is deliberately declined.
    res.writeHead(500, { 'cache-control': 'max-age=60' })
    res.end('error')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), method: 'GET', path: '/e', headers: {}, cache: { store } }

  await rawRequest(dispatch, opts)
  await flush()
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, '500 refetched — not cached')
  t.end()
})

test('storability: 404 with Expires is cached; 404 without any freshness is not', async (t) => {
  // Expires path (the other explicit-freshness source).
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    const fresh = req.url === '/fresh'
    const h = { 'content-type': 'text/plain' }
    if (fresh) h.expires = new Date(Date.now() + 60e3).toUTCString()
    res.writeHead(404, h)
    res.end('missing')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const mk = (path) => ({
    origin: origin(server),
    method: 'GET',
    path,
    headers: {},
    cache: { store },
  })

  await rawRequest(dispatch, mk('/fresh'))
  await flush()
  await rawRequest(dispatch, mk('/fresh'))
  t.equal(hits, 1, '404 + Expires cached')

  await rawRequest(dispatch, mk('/bare'))
  await flush()
  await rawRequest(dispatch, mk('/bare'))
  t.equal(hits, 3, '404 without freshness refetched (2 more hits)')
  t.end()
})

// The other origin-driven storability signal (besides explicit freshness):
// unqualified `Cache-Control: no-cache` + a validator. determineLifetime
// returns null for it, but CacheHandler's store-and-revalidate path (undici PR
// #5515) then stores it with lifetime 0 / explicit — for EVERY admitted status,
// not just 200. Each reuse must revalidate with a conditional request and, on a
// 304, serve the cached status/body instead of a full refetch.
for (const { status, extra, body } of CASES) {
  test(`storability: ${status} with no-cache + a validator stores and revalidates (304)`, async (t) => {
    const etag = '"v1"'
    let conditional = 0
    const server = await startServer((req, res) => {
      if (req.headers['if-none-match'] === etag) {
        conditional++
        res.writeHead(304, { etag, 'cache-control': 'no-cache', ...extra })
        res.end()
        return
      }
      res.writeHead(status, { etag, 'cache-control': 'no-cache', ...extra })
      res.end(body)
    })
    t.teardown(server.close.bind(server))

    const store = new SqliteCacheStore({ location: ':memory:' })
    t.teardown(() => store.close())
    const dispatch = makeDispatch()
    const opts = {
      origin: origin(server),
      method: 'GET',
      path: '/nc',
      headers: {},
      cache: { store },
    }

    const miss = await rawRequest(dispatch, opts)
    t.equal(miss.statusCode, status, 'miss: origin status')
    t.equal(miss.body, body)
    await flush()

    const hit = await rawRequest(dispatch, opts)
    t.equal(conditional, 1, `${status} revalidated with a conditional request (If-None-Match)`)
    t.equal(hit.statusCode, status, 'hit: cached status served after 304')
    t.equal(hit.body, body, 'hit: cached body served after 304')
    if (extra.location) {
      t.equal(
        hit.headers.location,
        extra.location,
        'redirect Location preserved through revalidation',
      )
    }
    t.end()
  })
}

test('storability: no-cache WITHOUT a validator is not stored (nothing to revalidate)', async (t) => {
  // no-cache stores with lifetime 0, so it is stale on arrival: without a
  // validator there is no cheap revalidation and computeEntryTimes declines it.
  for (const { status, extra, body } of CASES) {
    let hits = 0
    const server = await startServer((req, res) => {
      hits++
      res.writeHead(status, { 'cache-control': 'no-cache', ...extra })
      res.end(body)
    })
    t.teardown(server.close.bind(server))
    const store = new SqliteCacheStore({ location: ':memory:' })
    t.teardown(() => store.close())
    const dispatch = makeDispatch()
    const opts = {
      origin: origin(server),
      method: 'GET',
      path: '/nv',
      headers: {},
      cache: { store },
    }

    await rawRequest(dispatch, opts)
    await flush()
    await rawRequest(dispatch, opts)
    t.equal(hits, 2, `${status} with bare no-cache and no validator is refetched, not stored`)
  }
  t.end()
})
