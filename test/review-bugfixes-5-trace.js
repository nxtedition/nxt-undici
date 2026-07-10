/* eslint-disable */
// Regression tests for the 2026-07 cache deep-review fixes (trace-doc
// invariants):
// - synchronous revalidation must emit exactly one `undici:cache` lookup doc
//   on EVERY terminal — previously the pass (full-replacement), error and
//   abort terminals emitted none, so hit-rate metrics overstated hits and
//   revalidation failures were invisible.
// - the stale/validated serve variants must be distinguishable from fresh
//   hits via `reason` (revalidated / stale-if-error / max-stale /
//   stale-while-revalidate) while keeping result 'hit'.
// - traceUrl converges string origins with trailing slashes (URL instances
//   stringify to 'http://x/' and produced 'http://x//p' url tags that failed
//   to join with undici:request docs).
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, Agent, SqliteCacheStore } from '../lib/index.js'
import { traceUrl } from '../lib/trace.js'

test('traceUrl: trailing-slash string origins converge with URL-instance origins', (t) => {
  t.equal(traceUrl({ origin: 'http://x.test/', path: '/p' }), 'http://x.test/p')
  t.equal(
    traceUrl({ origin: 'http://x.test/', path: '/p' }),
    traceUrl({ origin: new URL('http://x.test'), path: '/p' }),
    'string artifact and URL instance produce the same tag',
  )
  t.equal(
    traceUrl({ origin: 'http://x.test', path: '/p' }),
    'http://x.test/p',
    'unchanged without slash',
  )
  t.end()
})

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

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

function seedStale(store, origin, { directives = { 'max-age': 5 }, etag = '"v1"' } = {}) {
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
      headers: { etag, 'cache-control': 'max-age=5' },
      cacheControlDirectives: directives,
      etag,
      vary: {},
      cachedAt: now - 10e3,
      staleAt: now - 5e3,
      deleteAt: now + 3600e3,
    },
  )
}

const settle = () => new Promise((r) => setImmediate(r))

function lookups(writer) {
  return writer.docs.filter((doc) => doc.op === 'undici:cache')
}

test('trace: revalidation replaced by a full 200 emits one miss/revalidated lookup doc', async (t) => {
  const server = await startServer((req, res) => {
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
  const { body } = await request(origin, {
    trace: writer,
    cache: { store },
    dispatcher: makeDispatcher(t),
  })
  t.equal(await body.text(), 'fresh-body')

  const docs = lookups(writer)
  t.equal(docs.length, 1, 'exactly one lookup doc for the dispatch')
  t.equal(docs[0].result, 'miss')
  t.equal(docs[0].reason, 'revalidated')
  t.end()
})

test('trace: 304-validated serve is reason revalidated; fresh hit stays reason null', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(304, { etag: '"v1"', 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))
  const origin = `http://127.0.0.1:${server.address().port}`

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  seedStale(store, origin)
  await settle()

  const writer = makeWriter()
  const dispatcher = makeDispatcher(t)
  const res1 = await request(origin, { trace: writer, cache: { store }, dispatcher })
  t.equal(await res1.body.text(), 'stale-body')
  await settle()
  const res2 = await request(origin, { trace: writer, cache: { store }, dispatcher })
  t.equal(await res2.body.text(), 'stale-body')

  const docs = lookups(writer)
  t.equal(docs.length, 2)
  t.equal(docs[0].result, 'hit')
  t.equal(docs[0].reason, 'revalidated', 'validated serve is attributable')
  t.equal(docs[1].result, 'hit')
  t.equal(docs[1].reason, null, 'plain fresh hit keeps the null reason')
  t.end()
})

test('trace: stale-if-error serve is reason stale-if-error', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(503, {})
    res.end('down')
  })
  t.teardown(server.close.bind(server))
  const origin = `http://127.0.0.1:${server.address().port}`

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  seedStale(store, origin, { directives: { 'max-age': 5, 'stale-if-error': 600 } })
  await settle()

  const writer = makeWriter()
  const res = await request(origin, {
    trace: writer,
    cache: { store },
    dispatcher: makeDispatcher(t),
  })
  t.equal(await res.body.text(), 'stale-body')

  const docs = lookups(writer)
  t.equal(docs.length, 1)
  t.equal(docs[0].result, 'hit')
  t.equal(docs[0].reason, 'stale-if-error')
  t.end()
})

test('trace: revalidation failure with no stale window emits miss/revalidate-error', async (t) => {
  const server = await startServer((req, res) => {
    res.destroy() // connection error, no stale-if-error window on the entry
  })
  t.teardown(server.close.bind(server))
  const origin = `http://127.0.0.1:${server.address().port}`

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  seedStale(store, origin)
  await settle()

  const writer = makeWriter()
  await t.rejects(
    request(origin, {
      trace: writer,
      cache: { store },
      dispatcher: makeDispatcher(t),
      retry: false,
    }),
    'revalidation error propagates',
  )

  const docs = lookups(writer)
  t.equal(docs.length, 1, 'the failed revalidation still emits its lookup doc')
  t.equal(docs[0].result, 'miss')
  t.equal(docs[0].reason, 'revalidate-error')
  t.end()
})

test('trace: max-stale and stale-while-revalidate serves carry their reasons', async (t) => {
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
  const dispatcher = makeDispatcher(t)

  seedStale(store, origin)
  await settle()
  const writer1 = makeWriter()
  const res1 = await request(origin, {
    trace: writer1,
    cache: { store },
    dispatcher,
    headers: { 'cache-control': 'max-stale=600' },
  })
  t.equal(await res1.body.text(), 'stale-body')
  t.equal(lookups(writer1)[0].reason, 'max-stale')

  seedStale(store, origin, { directives: { 'max-age': 5, 'stale-while-revalidate': 600 } })
  await settle()
  const writer2 = makeWriter()
  const res2 = await request(origin, { trace: writer2, cache: { store }, dispatcher })
  t.equal(await res2.body.text(), 'stale-body')
  t.equal(lookups(writer2)[0].reason, 'stale-while-revalidate')
  t.end()
})
