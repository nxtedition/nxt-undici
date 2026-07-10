// Regression test for the 2026-07 cache deep-review fix: stale-if-error
// failover must not be stalled behind the retry interceptor's full backoff
// schedule. With the default retry: 8, a 503 from the origin was buffered and
// status-code-retried for ~60-120s (hammering the failing origin with up to 9
// requests) before RevalidationHandler ever saw it and served the stale
// entry. When allowStaleOnError is true the revalidation dispatch now carries
// retry: 1 — one immediate re-attempt, then the stale serve.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, Agent, SqliteCacheStore } from '../lib/index.js'

test('stale-if-error serves the stale entry fast despite the default retry schedule', async (t) => {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.writeHead(503, {})
    res.end('down')
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(() => server.close())
  const origin = `http://0.0.0.0:${server.address().port}`

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
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
      headers: { etag: '"v1"', 'cache-control': 'max-age=5, stale-if-error=600' },
      cacheControlDirectives: { 'max-age': 5, 'stale-if-error': 600 },
      etag: '"v1"',
      vary: {},
      cachedAt: now - 10e3,
      staleAt: now - 5e3,
      deleteAt: now + 3600e3,
    },
  )
  await new Promise((r) => setImmediate(r))

  const dispatcher = new Agent()
  t.teardown(() => dispatcher.close())

  const started = Date.now()
  // Full wrapped pipeline (retry interceptor included), default retry budget.
  // Pre-fix this took 60s+; the 5s race bounds the failure fast.
  let deadline
  const res = await Promise.race([
    request(origin, { cache: { store }, dispatcher }),
    new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error('stale-if-error failover stalled behind retry backoff')),
        5000,
      )
    }),
  ]).finally(() => clearTimeout(deadline))
  const elapsed = Date.now() - started
  const text = await res.body.text()

  t.equal(res.statusCode, 200, 'stale entry served')
  t.equal(text, 'stale-body')
  t.ok(elapsed < 5000, `served in ${elapsed}ms`)
  t.ok(hits <= 3, `origin not hammered (got ${hits} hits)`)
  t.end()
})

test('stale-if-error preserves an explicit retry opt-out (no forced extra attempt)', async (t) => {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.writeHead(503, {})
    res.end('down')
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(() => server.close())
  const origin = `http://0.0.0.0:${server.address().port}`

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
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
      headers: { etag: '"v1"', 'cache-control': 'max-age=5, stale-if-error=600' },
      cacheControlDirectives: { 'max-age': 5, 'stale-if-error': 600 },
      etag: '"v1"',
      vary: {},
      cachedAt: now - 10e3,
      staleAt: now - 5e3,
      deleteAt: now + 3600e3,
    },
  )
  await new Promise((r) => setImmediate(r))

  const dispatcher = new Agent()
  t.teardown(() => dispatcher.close())

  // retry: false is an explicit opt-out — stale-if-error must not force an
  // extra re-attempt on top of it (Copilot review finding on #64).
  const res = await request(origin, { cache: { store }, dispatcher, retry: false })
  const text = await res.body.text()

  t.equal(res.statusCode, 200, 'stale entry still served')
  t.equal(text, 'stale-body')
  t.equal(hits, 1, 'exactly one origin attempt — the opt-out is preserved')
  t.end()
})
