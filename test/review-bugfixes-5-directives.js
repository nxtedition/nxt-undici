/* eslint-disable */
// Regression tests for the 2026-07 cache deep-review fixes (directive parsing
// and freshness semantics):
// - malformed valued forms of no-store / must-revalidate / proxy-revalidate
//   (and empty-valued private= / no-cache=) must fail RESTRICTIVE (treated as
//   the bare directive), not be silently dropped — dropping no-store="x"
//   stored responses the origin forbade.
// - duplicated delta-seconds directives must keep the conservative value for
//   ALL of max-age / s-maxage / stale-while-revalidate / stale-if-error /
//   max-stale (smaller) and min-fresh (larger) — previously only max-age.
// - present-but-malformed max-age / s-maxage must surface as explicit
//   lifetime 0 (like invalid Expires), not as absent (which fell through to
//   Expires / heuristics and over-cached).
// - immutable is an origin-sent directive, so it grants freshness for every
//   status CacheHandler admits (200/206/307) like a large explicit max-age;
//   only the cache-invented heuristic/defaultTTL lifetimes stay 200-only.
// - a response arriving already stale but inside its stale-while-revalidate /
//   stale-if-error window must be stored even without a validator (RFC 5861
//   SWR needs no validator).
// - RFC 9111 §5.2.2.10: s-maxage implies proxy-revalidate — request-driven
//   stale relaxations (max-stale, request stale-if-error) must not serve an
//   s-maxage entry stale without validation.
// - parseHttpDate: token case variants and mismatched weekday names must not
//   reject an otherwise-valid HTTP-date (a future Expires became "already
//   expired").
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { parseCacheControl, parseHttpDate } from '../lib/utils.js'
import {
  determineLifetime,
  computeEntryTimes,
  forbidsRequestDrivenStale,
} from '../lib/interceptor/cache/freshness.js'
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

// ---------------------------------------------------------------------------
// parseCacheControl
// ---------------------------------------------------------------------------

test('parseCacheControl: malformed valued no-store/must-revalidate/proxy-revalidate fail restrictive', (t) => {
  t.strictSame(
    parseCacheControl('no-store="x", max-age=60'),
    { 'no-store': true, 'max-age': 60 },
    'no-store="x" is treated as bare no-store',
  )
  t.strictSame(parseCacheControl('no-store='), { 'no-store': true }, 'no-store= fails restrictive')
  t.strictSame(
    parseCacheControl('must-revalidate="etag"'),
    { 'must-revalidate': true },
    'must-revalidate with value fails restrictive',
  )
  t.strictSame(
    parseCacheControl('proxy-revalidate='),
    { 'proxy-revalidate': true },
    'proxy-revalidate= fails restrictive',
  )
  // Permission-granting valueless directives keep the opposite (drop) rule.
  t.strictSame(parseCacheControl('public='), {}, 'public= still ignored')
  t.strictSame(parseCacheControl('immutable=x'), {}, 'immutable=x still ignored')
  t.end()
})

test('parseCacheControl: empty-valued private= / no-cache= fail restrictive (unqualified)', (t) => {
  t.strictSame(parseCacheControl('private='), { private: true }, 'private= is unqualified private')
  t.strictSame(
    parseCacheControl('no-cache='),
    { 'no-cache': true },
    'no-cache= is unqualified no-cache',
  )
  // The quoted-empty variants must not slip through the qualified-field-list
  // path as a non-restrictive empty list (Copilot review finding on #63).
  t.strictSame(parseCacheControl('private=""'), { private: true }, 'private="" fails restrictive')
  t.strictSame(
    parseCacheControl('no-cache=""'),
    { 'no-cache': true },
    'no-cache="" fails restrictive',
  )
  t.strictSame(
    parseCacheControl('private=","'),
    { private: true },
    'quoted list of only empty members fails restrictive',
  )
  t.strictSame(
    parseCacheControl('private="set-cookie,"'),
    { private: ['set-cookie'] },
    'empty members are dropped, real field names kept',
  )
  t.end()
})

test('parseCacheControl: duplicated delta-seconds directives keep the conservative value', (t) => {
  t.strictSame(
    parseCacheControl('s-maxage=1, s-maxage=31536000'),
    { 's-maxage': 1 },
    'duplicate s-maxage keeps the smaller',
  )
  t.strictSame(
    parseCacheControl('stale-while-revalidate=600, stale-while-revalidate=5'),
    { 'stale-while-revalidate': 5 },
    'duplicate stale-while-revalidate keeps the smaller',
  )
  t.strictSame(
    parseCacheControl('stale-if-error=5, stale-if-error=600'),
    { 'stale-if-error': 5 },
    'duplicate stale-if-error keeps the smaller',
  )
  t.strictSame(
    parseCacheControl('min-fresh=5, min-fresh=60'),
    { 'min-fresh': 60 },
    'duplicate min-fresh keeps the LARGER (more restrictive demand)',
  )
  t.strictSame(
    parseCacheControl('max-stale, max-stale=60'),
    { 'max-stale': 60 },
    'bare max-stale does not widen an existing bounded max-stale',
  )
  t.strictSame(
    parseCacheControl('max-stale=60, max-stale'),
    { 'max-stale': 60 },
    'trailing bare max-stale does not widen either',
  )
  t.strictSame(
    parseCacheControl('max-stale'),
    { 'max-stale': Infinity },
    'bare max-stale alone is unbounded',
  )
  t.end()
})

test('parseCacheControl: present-but-malformed max-age/s-maxage surfaces as 0, not absent', (t) => {
  t.strictSame(parseCacheControl('max-age=-1'), { 'max-age': 0 }, 'negative max-age -> 0')
  t.strictSame(parseCacheControl('max-age=100a'), { 'max-age': 0 }, 'trailing junk -> 0')
  t.strictSame(parseCacheControl('s-maxage=1.5'), { 's-maxage': 0 }, 'fractional s-maxage -> 0')
  t.strictSame(
    parseCacheControl('stale-while-revalidate=junk'),
    {},
    'non-freshness delta-seconds directives are still dropped when malformed',
  )
  // The 0 participates in the conservative duplicate rule.
  t.strictSame(
    parseCacheControl('max-age=60, max-age=junk'),
    { 'max-age': 0 },
    'malformed duplicate renders stale',
  )
  t.end()
})

test('determineLifetime: malformed max-age no longer falls through to Expires', (t) => {
  const now = Date.now()
  const directives = parseCacheControl('max-age=-1') ?? {}
  const headers = { expires: new Date(now + 3600e3).toUTCString() }
  const info = determineLifetime(200, headers, directives, {}, now)
  t.strictSame(info, { lifetime: 0, explicit: true }, 'explicit stale, not 1h of Expires freshness')
  t.end()
})

// ---------------------------------------------------------------------------
// freshness.js
// ---------------------------------------------------------------------------

test('determineLifetime: immutable applies to every admitted status (like a large max-age)', (t) => {
  const now = Date.now()
  // immutable is origin-sent, so — like s-maxage/max-age/Expires — it is NOT
  // status-gated; it grants the same lifetime to every status CacheHandler
  // admits. Only the cache-invented heuristic/defaultTTL lifetimes are 200-only.
  for (const statusCode of [200, 206, 301, 307, 308, 404, 410]) {
    const info = determineLifetime(statusCode, {}, { immutable: true }, {}, now)
    t.ok(info && info.lifetime > 0, `immutable grants freshness for ${statusCode}`)
    // immutable is origin-provided, so it is explicit (like max-age), not a
    // cache-invented lifetime — matters for store-and-revalidate gating.
    t.equal(info.explicit, true, `immutable is explicit freshness for ${statusCode}`)
  }
  // The cache-invented lifetimes stay 200-only.
  t.equal(
    determineLifetime(
      307,
      { 'last-modified': new Date(now - 1e6).toUTCString() },
      {},
      { heuristic: true },
      now,
    ),
    null,
    'heuristic freshness is not extended to 307',
  )
  t.end()
})

test('computeEntryTimes: stale-on-arrival response within its SWR window is stored without a validator', (t) => {
  const now = Date.now()
  // lifetime 5s, arrived with age 10s: stale on arrival, but swr=300 grants a
  // serve-stale window through age 305.
  const withSwr = computeEntryTimes(
    5,
    true,
    10,
    { 'stale-while-revalidate': 300 },
    3600,
    false,
    now,
  )
  t.ok(withSwr, 'stored')
  t.ok(withSwr.deleteAt > now, 'retention covers the remaining window')
  t.ok(withSwr.staleAt <= now, 'still stale on arrival')

  const sieOnly = computeEntryTimes(5, true, 10, { 'stale-if-error': 300 }, 3600, false, now)
  t.ok(sieOnly, 'stale-if-error window also qualifies')

  t.equal(
    computeEntryTimes(5, true, 10, {}, 3600, false, now),
    null,
    'no validator and no window: still not stored',
  )
  t.equal(
    computeEntryTimes(5, true, 400, { 'stale-while-revalidate': 300 }, 3600, false, now),
    null,
    'window already exhausted on arrival: not stored',
  )
  t.end()
})

test('forbidsRequestDrivenStale: s-maxage implies proxy-revalidate', (t) => {
  t.equal(forbidsRequestDrivenStale({ cacheControlDirectives: { 's-maxage': 60 } }), true)
  t.equal(forbidsRequestDrivenStale({ cacheControlDirectives: { 'max-age': 60 } }), false)
  t.equal(forbidsRequestDrivenStale({ cacheControlDirectives: { 'must-revalidate': true } }), true)
  t.equal(forbidsRequestDrivenStale({}), false)
  t.end()
})

// ---------------------------------------------------------------------------
// s-maxage vs request-driven stale paths (integration)
// ---------------------------------------------------------------------------

function seedStale(store, originStr, { directives, etag = '"v1"' }) {
  const now = Date.now()
  const body = Buffer.from('stale-body')
  store.set(
    { origin: originStr, method: 'GET', path: '/x', headers: {} },
    {
      body,
      start: 0,
      end: body.length,
      statusCode: 200,
      statusMessage: 'OK',
      headers: { etag, 'cache-control': 'placeholder' },
      cacheControlDirectives: directives,
      etag,
      vary: {},
      cachedAt: now - 10e3,
      staleAt: now - 5e3,
      deleteAt: now + 3600e3,
    },
  )
}

test('request max-stale must not serve an s-maxage entry stale (revalidates instead)', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('fresh-body')
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const opts = (headers) => ({
    origin: origin(server),
    method: 'GET',
    path: '/x',
    headers,
    cache: { store },
  })

  // Control: a plain max-age entry IS served stale under max-stale.
  seedStale(store, origin(server), { directives: { 'max-age': 5 } })
  await new Promise((r) => setImmediate(r))
  const control = await rawRequest(dispatch, opts({ 'cache-control': 'max-stale=600' }))
  t.equal(control.body, 'stale-body', 'control: max-age entry served stale')
  t.equal(hits, 0, 'control: origin not contacted')

  // s-maxage entry: max-stale must not relax it — forward validation happens.
  seedStale(store, origin(server), { directives: { 's-maxage': 5 } })
  await new Promise((r) => setImmediate(r))
  const res = await rawRequest(dispatch, opts({ 'cache-control': 'max-stale=600' }))
  t.equal(res.body, 'fresh-body', 's-maxage entry not served stale')
  t.ok(hits >= 1, 'origin was revalidated')
  t.end()
})

test('request stale-if-error must not serve an s-maxage entry stale on origin 5xx', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(503, {})
    res.end('nope')
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()
  const opts = (headers) => ({
    origin: origin(server),
    method: 'GET',
    path: '/x',
    headers,
    cache: { store },
  })

  // Control: plain max-age entry is served stale via request stale-if-error.
  seedStale(store, origin(server), { directives: { 'max-age': 5 } })
  await new Promise((r) => setImmediate(r))
  const control = await rawRequest(dispatch, opts({ 'cache-control': 'stale-if-error=600' }))
  t.equal(control.statusCode, 200, 'control: stale served on 503')
  t.equal(control.body, 'stale-body')

  // s-maxage entry: the request directive must not relax it — 503 surfaces.
  seedStale(store, origin(server), { directives: { 's-maxage': 5 } })
  await new Promise((r) => setImmediate(r))
  const res = await rawRequest(dispatch, opts({ 'cache-control': 'stale-if-error=600' }))
  t.equal(res.statusCode, 503, 's-maxage entry not served stale on error')
  t.end()
})

test("origin's own stale-while-revalidate on an s-maxage entry still works (explicit grant)", async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('fresh-body')
  })
  t.teardown(() => server.close())

  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const dispatch = makeDispatch()

  seedStale(store, origin(server), {
    directives: { 's-maxage': 5, 'stale-while-revalidate': 600 },
  })
  await new Promise((r) => setImmediate(r))
  const res = await rawRequest(dispatch, {
    origin: origin(server),
    method: 'GET',
    path: '/x',
    headers: {},
    cache: { store },
  })
  t.equal(res.body, 'stale-body', 'served stale per the origin grant')
  t.end()
})

// ---------------------------------------------------------------------------
// parseHttpDate leniency
// ---------------------------------------------------------------------------

test('parseHttpDate: case variants and mismatched weekday are accepted; real garbage still rejected', (t) => {
  const expected = Date.UTC(1994, 10, 6, 8, 49, 37)
  t.equal(
    parseHttpDate('SUN, 06 NOV 1994 08:49:37 gmt')?.getTime(),
    expected,
    'case-insensitive tokens',
  )
  t.equal(
    parseHttpDate('Mon, 06 Nov 1994 08:49:37 GMT')?.getTime(),
    expected,
    'mismatched weekday name is ignored (RFC 9110 recipients may be lenient)',
  )
  t.equal(
    parseHttpDate('Thu Aug  8 02:01:18 2050')?.getTime(),
    Date.UTC(2050, 7, 8, 2, 1, 18),
    'asctime with wrong weekday (conformance freshness-expires-ansi-c shape)',
  )
  t.equal(
    parseHttpDate('Wed, 30 Feb 2022 00:00:00 GMT'),
    undefined,
    'nonexistent date still rejected',
  )
  t.equal(parseHttpDate('0'), undefined, 'Expires: 0 still invalid')
  t.equal(parseHttpDate('2026-07-04T00:00:00Z'), undefined, 'ISO 8601 still rejected')
  t.end()
})
