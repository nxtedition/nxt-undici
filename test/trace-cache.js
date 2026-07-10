import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, Agent, SqliteCacheStore, interceptors } from '../lib/index.js'

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

// Explicit dispatcher: under tap the global dispatcher may have been replaced
// by Node's built-in undici (fetch shares the globalDispatcher symbol), which
// rejects this library's handlers with "invalid onRequestStart method".
function makeDispatcher(t) {
  const dispatcher = new Agent()
  t.teardown(() => dispatcher.close())
  return dispatcher
}

function makeWriter() {
  const docs = []
  return {
    docs,
    write(obj, op) {
      docs.push({ ...obj, op })
    },
  }
}

// ---------------------------------------------------------------------------
// miss then hit: lookup docs at both outcomes + one stored cache-store doc
// ---------------------------------------------------------------------------

test('trace-cache: miss then hit with one stored doc', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('hello')
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })
  const origin = `http://127.0.0.1:${server.address().port}`
  const dispatcher = makeDispatcher(t)

  for (let n = 0; n < 2; n++) {
    const { body, statusCode } = await request(origin, {
      trace: writer,
      cache: { store },
      dispatcher,
    })
    t.equal(await body.text(), 'hello')
    t.equal(statusCode, 200)
  }
  t.equal(hits, 1, 'second request served from cache')

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 2, 'one lookup doc per dispatch')

  const [miss, hit] = lookups
  t.type(miss.id, 'string')
  t.equal(miss.method, 'GET')
  t.equal(miss.url, `${origin}/`)
  t.equal(miss.result, 'miss')
  t.equal(miss.reason, 'none')
  t.equal(miss.statusCode, null)
  t.equal(miss.ageSec, null)
  t.equal(miss.sizeBytes, null)
  t.type(miss.lookupMs, 'number')
  t.ok(miss.lookupMs >= 0)

  t.type(hit.id, 'string')
  t.not(hit.id, miss.id)
  t.equal(hit.method, 'GET')
  t.equal(hit.url, `${origin}/`)
  t.equal(hit.result, 'hit')
  t.equal(hit.reason, null)
  t.equal(hit.statusCode, 200)
  t.type(hit.ageSec, 'number')
  t.ok(hit.ageSec >= 0)
  t.equal(hit.sizeBytes, 5)
  t.type(hit.lookupMs, 'number')
  t.ok(hit.lookupMs >= 0)

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1, 'only the origin response emits a cache-store doc')

  const [stored] = stores
  t.equal(stored.id, miss.id)
  t.equal(stored.method, 'GET')
  t.equal(stored.url, `${origin}/`)
  t.equal(stored.statusCode, 200)
  t.equal(stored.stored, true)
  t.equal(stored.reason, null)
  t.equal(stored.sizeBytes, 5)
  t.equal(stored.ttlSec, 60)
  t.equal(stored.err, null)
})

// ---------------------------------------------------------------------------
// non-storable origin response → cache-store skipped with the failed gate
// ---------------------------------------------------------------------------

test('trace-cache: no-store response emits skipped cache-store doc', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 'no-store' })
    res.end('nope')
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })
  const origin = `http://127.0.0.1:${server.address().port}`

  const { body, statusCode } = await request(origin, {
    trace: writer,
    cache: { store },
    dispatcher: makeDispatcher(t),
  })
  t.equal(await body.text(), 'nope')
  t.equal(statusCode, 200)

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 1)
  t.equal(lookups[0].result, 'miss')
  t.equal(lookups[0].reason, 'none')

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1)

  const [skipped] = stores
  t.equal(skipped.id, lookups[0].id)
  t.equal(skipped.method, 'GET')
  t.equal(skipped.url, `${origin}/`)
  t.equal(skipped.statusCode, 200)
  t.equal(skipped.stored, false)
  t.equal(skipped.reason, 'no-store')
  t.equal(skipped.sizeBytes, null)
  t.equal(skipped.ttlSec, null)
  t.equal(skipped.err, null)
})

// ---------------------------------------------------------------------------
// unsafe method against a cached URL → cache-invalidate doc
// ---------------------------------------------------------------------------

test('trace-cache: POST to a cached URL emits cache-invalidate doc', async (t) => {
  const server = await startServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'cache-control': 'max-age=60' })
      res.end('hello')
    } else {
      req.resume()
      res.end('ok')
    }
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })
  const origin = `http://127.0.0.1:${server.address().port}`
  const dispatcher = makeDispatcher(t)

  // Populate the cache, then invalidate it with an unsafe method.
  const get = await request(origin, { trace: writer, cache: { store }, dispatcher })
  t.equal(await get.body.text(), 'hello')

  const post = await request(origin, {
    method: 'POST',
    body: 'x',
    trace: writer,
    cache: { store },
    dispatcher,
  })
  t.equal(await post.body.text(), 'ok')
  t.equal(post.statusCode, 200)

  const invalidations = writer.docs.filter((doc) => doc.op === 'undici:cache-invalidate')
  t.equal(invalidations.length, 1)

  const [invalidated] = invalidations
  t.type(invalidated.id, 'string')
  t.equal(invalidated.method, 'POST')
  t.equal(invalidated.url, `${origin}/`)
  t.equal(invalidated.statusCode, 200)
  t.ok(invalidated.paths >= 1)
  t.equal(invalidated.err, null)
})

// ---------------------------------------------------------------------------
// only-if-cached against a cold cache → the synthetic 504 is a miss, not a hit
// ---------------------------------------------------------------------------

test('trace-cache: only-if-cached 504 is a miss with reason only-if-cached', async (t) => {
  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })

  // No server: only-if-cached forbids going to origin, so the cache answers
  // with a synthetic 504 (RFC 9111 §5.2.1.7) without dispatching.
  const { body, statusCode } = await request('http://127.0.0.1:1', {
    trace: writer,
    cache: { store },
    error: false,
    headers: { 'cache-control': 'only-if-cached' },
    dispatcher: makeDispatcher(t),
  })
  await body.dump()
  t.equal(statusCode, 504)

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 1)

  const [doc] = lookups
  t.equal(doc.result, 'miss', 'the cache could not satisfy the request')
  t.equal(doc.reason, 'only-if-cached')
  t.equal(doc.statusCode, 504)
  t.equal(doc.ageSec, null)

  t.equal(
    writer.docs.filter((doc) => doc.op === 'undici:cache-store').length,
    0,
    'nothing was dispatched, so nothing passed a storability gate',
  )
})

// ---------------------------------------------------------------------------
// store.set() throws → the cache-store doc must not claim stored: true
// ---------------------------------------------------------------------------

test('trace-cache: throwing store.set emits stored false with err tag', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('hello')
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = {
    get: () => undefined,
    set: () => {
      throw new Error('database is locked')
    },
  }

  const { body, statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    trace: writer,
    cache: { store },
    dispatcher: makeDispatcher(t),
  })
  t.equal(await body.text(), 'hello')
  t.equal(statusCode, 200)

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1)

  const [doc] = stores
  t.equal(doc.stored, false, 'a failed set persisted nothing')
  t.equal(doc.reason, null, 'a store failure is not a storability gate')
  t.equal(doc.err, 'database is locked')
  t.type(doc.sizeBytes, 'number')
  t.type(doc.ttlSec, 'number')
})

// ---------------------------------------------------------------------------
// interim 1xx forwarded by a composed dispatcher → no spurious cache-store doc
// ---------------------------------------------------------------------------

test('trace-cache: forwarded 1xx emits no cache-store doc', async (t) => {
  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })

  // Raw undici strips interim responses, but composed/mock dispatchers may
  // forward them (same shape the redirect/response-verify guards exercise).
  const inner = (opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(103, {}, () => {})
    handler.onHeaders(200, { 'cache-control': 'max-age=60' }, () => {})
    handler.onData(Buffer.from('hello'))
    handler.onComplete({})
    return true
  }
  const dispatch = interceptors.cache()(inner)

  await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
        cache: { store },
        trace: writer,
      },
      {
        onConnect() {},
        onHeaders() {},
        onData() {},
        onComplete() {
          resolve()
        },
        onError(err) {
          reject(err)
        },
      },
    )
  })

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1, 'exactly one storability outcome per response')
  t.equal(stores[0].statusCode, 200)
  t.equal(stores[0].stored, true)
})

// ---------------------------------------------------------------------------
// non-cacheable FINAL status → cache-store skipped with reason 'status'
// (interim 1xx stays silent; regression guard for the trace port on rebase)
// ---------------------------------------------------------------------------

test('trace-cache: non-cacheable status emits a skipped cache-store doc (reason status)', async (t) => {
  const server = await startServer((req, res) => {
    // 500 is not on the cacheable-status list (404 now is, with explicit
    // freshness — see cache-storable-statuses), so it skips with reason
    // 'status' even carrying max-age.
    res.writeHead(500, { 'cache-control': 'max-age=60' })
    res.end('boom')
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })
  const origin = `http://127.0.0.1:${server.address().port}`

  // request() throws on the 500 (response-error interceptor); the cache-store
  // doc is emitted synchronously in CacheHandler.onHeaders before the error
  // propagates, so it's already recorded.
  await request(origin, {
    trace: writer,
    cache: { store },
    dispatcher: makeDispatcher(t),
  }).then(
    ({ body }) => body.dump(),
    () => {},
  )

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1, 'the non-cacheable status still emits one skip doc')
  t.equal(stores[0].statusCode, 500)
  t.equal(stores[0].stored, false)
  t.equal(stores[0].reason, 'status')
})

// ---------------------------------------------------------------------------
// background stale-while-revalidate refresh: the stale serve emits the one
// lookup doc; the fire-and-forget refresh emits the cache-store doc for its
// store write, tagged with the triggering request's id — no second lookup doc.
// ---------------------------------------------------------------------------

const settle = () => new Promise((r) => setImmediate(r))

// Poll for a condition with a bounded deadline so a never-firing background
// refresh fails the test instead of hanging it.
async function waitFor(predicate, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

function seedStale(store, origin, { directives, etag = '' } = {}) {
  const now = Date.now()
  const body = Buffer.from('stale-body')
  const headers = { 'cache-control': 'max-age=5, stale-while-revalidate=600' }
  if (etag) {
    headers.etag = etag
  }
  store.set(
    { origin, method: 'GET', path: '/', headers: {} },
    {
      body,
      start: 0,
      end: body.length,
      statusCode: 200,
      statusMessage: 'OK',
      headers,
      cacheControlDirectives: directives ?? { 'max-age': 5, 'stale-while-revalidate': 600 },
      etag,
      vary: {},
      cachedAt: now - 10e3,
      staleAt: now - 5e3,
      deleteAt: now + 3600e3,
    },
  )
}

test('trace-cache: background SWR refresh (replacement) emits a store doc, no extra lookup', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('fresh-body')
  })
  t.teardown(server.close.bind(server))
  const origin = `http://127.0.0.1:${server.address().port}`

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  seedStale(store, origin)
  await settle()

  const writer = makeWriter()
  const res = await request(origin, {
    trace: writer,
    cache: { store },
    dispatcher: makeDispatcher(t),
  })
  t.equal(await res.body.text(), 'stale-body', 'the stale entry is served immediately')

  await waitFor(() => writer.docs.some((doc) => doc.op === 'undici:cache-store'), {
    label: 'background refresh store doc',
  })
  t.equal(hits, 1, 'the background refresh contacted the origin')

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 1, 'only the stale serve emits a lookup doc — the refresh emits none')
  t.equal(lookups[0].result, 'hit')
  t.equal(lookups[0].reason, 'stale-while-revalidate')

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1, 'the background refresh emits one store doc for the replacement')

  const [stored] = stores
  t.equal(stored.id, lookups[0].id, 'the store doc carries the triggering request id')
  t.equal(stored.method, 'GET')
  t.equal(stored.url, `${origin}/`)
  t.equal(stored.statusCode, 200)
  t.equal(stored.stored, true)
  t.equal(stored.reason, null)
  t.equal(stored.sizeBytes, 'fresh-body'.length)
  t.equal(stored.ttlSec, 60)
  t.equal(stored.err, null)
})

// ---------------------------------------------------------------------------
// background SWR refresh answered by a 304 → the freshen store write is visible
// as a cache-store doc, mirroring the replacement path above.
// ---------------------------------------------------------------------------

test('trace-cache: background SWR refresh (304 freshen) emits a store doc', async (t) => {
  let conditional = false
  const server = await startServer((req, res) => {
    conditional = req.headers['if-none-match'] === '"v1"'
    res.writeHead(304, { etag: '"v1"', 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))
  const origin = `http://127.0.0.1:${server.address().port}`

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  seedStale(store, origin, { etag: '"v1"' })
  await settle()

  const writer = makeWriter()
  const res = await request(origin, {
    trace: writer,
    cache: { store },
    dispatcher: makeDispatcher(t),
  })
  t.equal(await res.body.text(), 'stale-body')

  await waitFor(() => writer.docs.some((doc) => doc.op === 'undici:cache-store'), {
    label: 'background 304 freshen store doc',
  })
  t.ok(conditional, 'the refresh sent a conditional request')

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 1, 'the refresh adds no lookup doc')
  t.equal(lookups[0].reason, 'stale-while-revalidate')

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1, 'the 304-freshen store write emits one store doc')
  t.equal(stores[0].id, lookups[0].id)
  t.equal(stores[0].statusCode, 200, 'the freshened entry keeps its stored status')
  t.equal(stores[0].stored, true)
  t.equal(stores[0].reason, null)
  t.equal(stores[0].sizeBytes, 'stale-body'.length)
  t.equal(stores[0].err, null)
})

// ---------------------------------------------------------------------------
// synchronous 304 revalidation now emits a freshen cache-store doc alongside
// its lookup doc, matching the full-replacement path (which stores via
// CacheHandler). Regression guard for the freshen store-doc gap.
// ---------------------------------------------------------------------------

test('trace-cache: synchronous 304 freshen emits a cache-store doc', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(304, { etag: '"v1"', 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))
  const origin = `http://127.0.0.1:${server.address().port}`

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  // A plain stale entry (no stale-while-revalidate) forces synchronous
  // revalidation rather than a background refresh.
  const now = Date.now()
  const body = Buffer.from('stale-body')
  store.set(
    { origin, method: 'GET', path: '/', headers: {} },
    {
      body,
      start: 0,
      end: body.length,
      statusCode: 200,
      statusMessage: 'OK',
      headers: { etag: '"v1"', 'cache-control': 'max-age=5' },
      cacheControlDirectives: { 'max-age': 5 },
      etag: '"v1"',
      vary: {},
      cachedAt: now - 10e3,
      staleAt: now - 5e3,
      deleteAt: now + 3600e3,
    },
  )
  await settle()

  const writer = makeWriter()
  const res = await request(origin, {
    trace: writer,
    cache: { store },
    dispatcher: makeDispatcher(t),
  })
  t.equal(await res.body.text(), 'stale-body')

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 1)
  t.equal(lookups[0].result, 'hit')
  t.equal(lookups[0].reason, 'revalidated')

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1, 'the freshen store write is now traced')
  t.equal(stores[0].id, lookups[0].id)
  t.equal(stores[0].statusCode, 200)
  t.equal(stores[0].stored, true)
  t.equal(stores[0].reason, null)
})
