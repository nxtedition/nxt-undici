/* eslint-disable */
// Coverage for lib/interceptor/cache-revalidation.js edge paths: 1xx interim
// responses during revalidation, pass-mode error propagation, user aborts
// mid-revalidation, freshen edge cases (merged no-store/private, qualified
// field lists, Connection field lists, unusable 304 etags, unstorable times,
// Vary *, store.set failures, freshen exceptions) and backgroundRefresh
// bookkeeping (in-flight slot release, vary-less entries, sync throws).
// Stale entries are seeded directly (backdated staleAt) — no sleeps.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import { RevalidationHandler, backgroundRefresh } from '../lib/interceptor/cache-revalidation.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Seeds a stale-but-retained entry the way CacheHandler would have stored it.
function seedEntry(
  store,
  originStr,
  {
    path = '/',
    method = 'GET',
    body = 'cached-body',
    headers = {},
    cacheControlDirectives = {},
    etag = '',
    cachedAtOffset = -10e3,
    staleAtOffset = -5e3,
    deleteAtOffset = 3600e3,
  } = {},
) {
  const now = Date.now()
  const buf = Buffer.from(body)
  store.set(
    { origin: originStr, method, path, headers: {} },
    {
      body: buf,
      start: 0,
      end: buf.byteLength,
      statusCode: 200,
      statusMessage: '',
      headers,
      cacheControlDirectives,
      etag,
      vary: {},
      cachedAt: now + cachedAtOffset,
      staleAt: now + staleAtOffset,
      deleteAt: now + deleteAtOffset,
    },
  )
}

// A freshenable stale entry for driving RevalidationHandler directly.
function makeEntry(overrides = {}) {
  const now = Date.now()
  const buf = Buffer.from('cached-body')
  return {
    body: buf,
    start: 0,
    end: buf.byteLength,
    statusCode: 200,
    statusMessage: '',
    headers: { 'cache-control': 'max-age=5' },
    cacheControlDirectives: { 'max-age': 5 },
    etag: '"v1"',
    vary: {},
    cachedAt: now - 10e3,
    staleAt: now - 5e3,
    deleteAt: now + 3600e3,
    ...overrides,
  }
}

// Records every callback a served response makes on the user handler.
function makeRecorder() {
  const rec = {
    connects: 0,
    bridge: null,
    headersCalls: [],
    chunks: [],
    completes: 0,
    errors: [],
    handler: {
      onConnect(abort) {
        rec.connects++
        rec.bridge ??= abort
      },
      onHeaders(statusCode, headers) {
        rec.headersCalls.push({ statusCode, headers })
        return true
      },
      onData(chunk) {
        rec.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        return true
      },
      onComplete() {
        rec.completes++
      },
      onError(err) {
        rec.errors.push(err)
      },
    },
    body() {
      return Buffer.concat(rec.chunks).toString()
    },
  }
  return rec
}

const KEY = { origin: 'http://example.local', method: 'GET', path: '/', headers: {} }

// Bounded poll — never waits forever (see global waiting guidelines).
async function waitFor(cond, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// 1xx interim responses during revalidation
// ---------------------------------------------------------------------------

test('revalidation: 103 Early Hints before the 304 is ignored; 304 still freshens', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeEarlyHints({ link: '</style.css>; rel=preload' })
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    headers: { 'cache-control': 'max-age=5' },
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.statusCode, 200, 'interim 103 is not the revalidation answer')
  t.equal(first.body, 'cached-body', 'validated cached body is served')

  await flush()
  await rawRequest(dispatch, opts)
  t.equal(hits, 1, '304 after the 103 freshened the entry (no second origin hit)')
})

// ---------------------------------------------------------------------------
// Pass mode: replacement response failing mid-body
// ---------------------------------------------------------------------------

test('revalidation: replacement response error mid-body propagates to the user handler', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-length': '100', 'cache-control': 'max-age=60' })
    res.write('partial')
    setTimeout(() => res.destroy(), 10)
  })
  t.teardown(() => {
    server.closeAllConnections?.()
    server.close()
  })

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    headers: { 'cache-control': 'max-age=5' },
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  await t.rejects(rawRequest(dispatch, opts), undefined, 'mid-body failure surfaces as onError')
})

// ---------------------------------------------------------------------------
// User abort mid-revalidation (before the origin answers)
// ---------------------------------------------------------------------------

test('revalidation: user abort mid-revalidation surfaces the abort reason, not stale-if-error', async (t) => {
  t.plan(2)
  let release
  const held = []
  const server = await startServer((req, res) => {
    held.push(res)
    release?.()
  })
  t.teardown(() => {
    for (const res of held) res.destroy()
    server.closeAllConnections?.()
    server.close()
  })

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  // stale-if-error window is open — the user's own abort must still NOT be
  // converted into a successful stale serve.
  seedEntry(store, origin(server), {
    etag: '"v1"',
    headers: { 'cache-control': 'max-age=5, stale-if-error=600' },
    cacheControlDirectives: { 'max-age': 5, 'stale-if-error': 600 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  // Abort with an explicit reason: the reason (not undici's destroy error)
  // must reach the user handler.
  const err1 = await new Promise((resolve, reject) => {
    let bridge
    const arrived = new Promise((r) => {
      release = r
    })
    dispatch(opts, {
      onConnect(abort) {
        bridge = abort
        arrived.then(() => bridge(new Error('user-abort-reason')))
      },
      onHeaders() {
        reject(new Error('should not deliver headers'))
        return true
      },
      onData() {},
      onComplete() {
        reject(new Error('should not complete'))
      },
      onError: resolve,
    })
  })
  t.equal(err1.message, 'user-abort-reason', 'the abort reason is delivered verbatim')

  // Abort with NO reason: falls back to the underlying dispatch error.
  const err2 = await new Promise((resolve, reject) => {
    let bridge
    const arrived = new Promise((r) => {
      release = r
    })
    dispatch(opts, {
      onConnect(abort) {
        bridge = abort
        arrived.then(() => bridge())
      },
      onHeaders() {
        reject(new Error('should not deliver headers'))
        return true
      },
      onData() {},
      onComplete() {
        reject(new Error('should not complete'))
      },
      onError: resolve,
    })
  })
  t.ok(err2 instanceof Error, 'reasonless abort still surfaces an error')
})

// ---------------------------------------------------------------------------
// Freshen: origin withdraws cacheability on the 304
// ---------------------------------------------------------------------------

test('revalidation: 304 with no-store serves the validated entry but does not freshen it', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(304, { 'cache-control': 'no-store' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    headers: { 'cache-control': 'max-age=5' },
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.body, 'cached-body', 'validated body is served this once')
  t.equal(first.headers['cache-control'], 'no-store', 'merged headers reflect the 304')

  await flush()
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'entry stayed stale: the next request revalidates again')
})

test('revalidation: qualified no-cache/private field lists in the 304 strip the named fields', async (t) => {
  t.plan(5)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(304, { 'cache-control': 'max-age=60, no-cache="x-secret", private="x-other"' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    headers: { 'cache-control': 'max-age=5', 'x-secret': 'hush', 'x-other': 'aha' },
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.body, 'cached-body', 'validated body is served')
  t.notOk('x-secret' in first.headers, 'no-cache-listed field is stripped from the served headers')
  t.notOk('x-other' in first.headers, 'private-listed field is stripped from the served headers')

  await flush()
  const second = await rawRequest(dispatch, opts)
  t.equal(hits, 1, 'freshened entry (max-age=60) served without a second origin hit')
  t.notOk('x-secret' in second.headers, 'stored freshened headers lack the stripped field too')
})

test('revalidation: 304 granting no storable lifetime serves the validated entry without freshening', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // max-age=0 with no validator on either side: computeEntryTimes yields
    // nothing storable (stale on arrival, no cheap revalidation).
    res.writeHead(304, { 'cache-control': 'max-age=0' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '',
    headers: { 'content-type': 'text/plain' },
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.body, 'cached-body', 'validated body is served this once')

  await flush()
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'entry was not freshened: the next request revalidates again')
})

test('revalidation: 304 changing Vary to * serves the validated entry but cannot re-store it', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(304, { 'cache-control': 'max-age=60', vary: '*' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  seedEntry(store, origin(server), {
    etag: '"v1"',
    headers: { 'cache-control': 'max-age=5' },
    cacheControlDirectives: { 'max-age': 5 },
  })
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.body, 'cached-body', 'validated body is served')
  t.equal(first.headers.vary, '*', 'merged headers carry the new Vary')

  await flush()
  await rawRequest(dispatch, opts)
  t.equal(hits, 2, 'Vary * made the entry uncacheable: next request revalidates again')
})

// ---------------------------------------------------------------------------
// Freshen: store.set failures are logged, not fatal
// ---------------------------------------------------------------------------

test('revalidation: freshen store.set "database is locked" logs at debug and still serves', async (t) => {
  t.plan(3)
  const server = await startServer((req, res) => {
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const logs = []
  const store = {
    get: () => makeEntry(),
    set: () => {
      throw new Error('database is locked')
    },
  }
  const logger = {
    debug: (obj, msg) => logs.push(['debug', msg, obj.err]),
    error: (obj, msg) => logs.push(['error', msg, obj.err]),
  }
  const dispatch = makeDispatch()
  const opts = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
    logger,
  }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.body, 'cached-body', 'freshened entry is served despite the failed write')
  const entry = logs.find(([, msg]) => msg === 'failed to freshen cache entry')
  t.ok(entry, 'the failed freshen write is logged')
  t.equal(entry[0], 'debug', 'a locked database logs at debug level')
})

test('revalidation: freshen store.set unexpected failure logs at error and still serves', async (t) => {
  t.plan(3)
  const server = await startServer((req, res) => {
    res.writeHead(304, { 'cache-control': 'max-age=60' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const logs = []
  const store = {
    get: () => makeEntry(),
    set: () => {
      throw new Error('disk exploded')
    },
  }
  const logger = {
    debug: (obj, msg) => logs.push(['debug', msg, obj.err]),
    error: (obj, msg) => logs.push(['error', msg, obj.err]),
  }
  const dispatch = makeDispatch()
  const opts = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
    logger,
  }

  const res = await rawRequest(dispatch, opts)
  t.equal(res.body, 'cached-body', 'freshened entry is served despite the failed write')
  const entry = logs.find(([, msg]) => msg === 'failed to freshen cache entry')
  t.ok(entry, 'the failed freshen write is logged')
  t.equal(entry[0], 'error', 'an unexpected store failure logs at error level')
})

// ---------------------------------------------------------------------------
// RevalidationHandler direct drive: paths unreachable through a well-behaved
// origin (upgrade leaks, abort/response races, malformed 304 header shapes)
// ---------------------------------------------------------------------------

test('revalidation: a slipped-through upgrade destroys the socket and nothing else', async (t) => {
  t.plan(3)
  const rec = makeRecorder()
  const h = new RevalidationHandler(
    KEY,
    makeEntry(),
    {},
    {
      store: { get() {}, set() {} },
      handler: rec.handler,
      allowStaleOnError: false,
      cacheOpts: {},
    },
  )

  let destroyed = 0
  h.onUpgrade(
    101,
    {},
    {
      destroy() {
        destroyed++
      },
    },
  )
  t.equal(destroyed, 1, 'the upgrade socket is destroyed')

  t.doesNotThrow(() => h.onUpgrade(101, {}, null), 'null socket is tolerated')
  t.doesNotThrow(() => h.onUpgrade(101, {}, {}), 'socket without destroy is tolerated')
})

test('revalidation: user abort racing a completed 304 still freshens but reports the abort', async (t) => {
  t.plan(6)
  const sets = []
  const rec = makeRecorder()
  const abortSpy = []
  const h = new RevalidationHandler(
    KEY,
    makeEntry(),
    {},
    {
      store: {
        get() {},
        set(key, value) {
          sets.push(value)
        },
      },
      handler: rec.handler,
      allowStaleOnError: false,
      cacheOpts: {},
    },
  )

  h.onConnect((reason) => abortSpy.push(reason))
  t.ok(rec.bridge, 'the user handler received a bridging abort eagerly')
  const reason = new Error('user-cancel')
  rec.bridge(reason)
  t.equal(abortSpy[0], reason, 'the bridging abort tears down the in-flight request')

  // The 304 completes anyway (the abort raced the response).
  t.equal(
    h.onHeaders(304, { 'cache-control': 'max-age=60' }, () => {}),
    true,
  )
  h.onComplete({})

  t.equal(sets.length, 1, 'the 304 freshened the store even though the user aborted')
  t.equal(rec.errors[0], reason, 'the user gets their abort reason, not the response')
  t.equal(rec.headersCalls.length, 0, 'no response headers are delivered after an abort')
})

test('revalidation: reasonless abort racing a 304 (null headers) reports a generic aborted error', async (t) => {
  t.plan(4)
  const sets = []
  const rec = makeRecorder()
  const h = new RevalidationHandler(
    KEY,
    makeEntry(),
    {},
    {
      store: {
        get() {},
        set(key, value) {
          sets.push(value)
        },
      },
      handler: rec.handler,
      allowStaleOnError: false,
      cacheOpts: {},
    },
  )

  h.onConnect(() => {})
  rec.bridge()

  // A 304 with no headers at all: freshening falls back to the entry's own
  // cache-control (max-age=5) with a receipt-time Date.
  t.equal(
    h.onHeaders(304, null, () => {}),
    true,
  )
  h.onComplete({})

  t.equal(sets.length, 1, 'the header-less 304 still freshened from the stored cache-control')
  t.ok(rec.errors[0] instanceof Error, 'the user gets an error')
  t.equal(rec.errors[0].message, 'aborted', 'a reasonless abort maps to a generic aborted error')
})

test('revalidation: 304 Connection field list (array) excludes named fields; minimal entries freshen', async (t) => {
  t.plan(11)
  const now = Date.now()
  const sets = []
  const rec = makeRecorder()
  // Deliberately minimal entry: no headers, no body, no etag, no
  // statusMessage — every `??` fallback in freshen() must hold.
  const entry = {
    statusCode: 200,
    cachedAt: now - 10e3,
    staleAt: now - 5e3,
    deleteAt: now + 3600e3,
  }
  const h = new RevalidationHandler(
    KEY,
    entry,
    {},
    {
      store: {
        get() {},
        set(key, value) {
          sets.push(value)
        },
      },
      handler: rec.handler,
      allowStaleOnError: false,
      cacheOpts: {},
    },
  )

  h.onConnect(() => {})
  const multi = ['m1', 'm2']
  t.equal(
    h.onHeaders(
      304,
      {
        connection: ['x-a, x-b', 'x-c'],
        'cache-control': 'max-age=60',
        'x-a': '1',
        'x-b': '2',
        'x-c': '3',
        'x-multi': multi,
        etag: 'unquoted-garbage',
      },
      () => {},
    ),
    true,
  )
  t.equal(h.onData(Buffer.from('should be ignored')), true, 'data on a 304 is swallowed')
  h.onComplete({})

  t.equal(sets.length, 1, 'the minimal entry was freshened and re-stored')
  const stored = sets[0]
  t.notOk('x-a' in stored.headers, 'field named on the first Connection line is excluded')
  t.notOk('x-b' in stored.headers, 'second field on the same line is excluded')
  t.notOk('x-c' in stored.headers, 'field named on the second Connection line is excluded')
  t.strictSame(stored.headers['x-multi'], multi, 'array header values survive the merge')
  t.not(stored.headers['x-multi'], multi, 'array header values are copied, not shared')
  t.equal(stored.etag, '', 'an unusable 304 etag falls back to the (absent) stored etag')
  t.equal(stored.statusMessage, '', 'missing statusMessage defaults to the empty string')
  t.equal(rec.chunks.length, 0, 'a body-less entry serves no data')
})

test('revalidation: 304 withdrawing cacheability via private serves but does not re-store', async (t) => {
  t.plan(3)
  const sets = []
  const rec = makeRecorder()
  const h = new RevalidationHandler(
    KEY,
    makeEntry(),
    {},
    {
      store: {
        get() {},
        set(key, value) {
          sets.push(value)
        },
      },
      handler: rec.handler,
      allowStaleOnError: false,
      cacheOpts: {},
    },
  )

  h.onConnect(() => {})
  h.onHeaders(304, { 'cache-control': 'private, max-age=60' }, () => {})
  h.onComplete({})

  t.equal(sets.length, 0, 'a now-private response is never written to the shared store')
  t.equal(rec.body(), 'cached-body', 'this validated use is still served')
  t.equal(
    rec.headersCalls[0].headers['cache-control'],
    'private, max-age=60',
    'served headers carry the merged cache-control',
  )
})

test('revalidation: freshen exception falls back to serving the original entry', async (t) => {
  t.plan(4)
  const logs = []
  const sets = []
  const rec = makeRecorder()
  const h = new RevalidationHandler(
    KEY,
    makeEntry(),
    {},
    {
      store: {
        get() {},
        set(key, value) {
          sets.push(value)
        },
      },
      logger: {
        debug: () => {},
        error: (obj, msg) => logs.push([msg, obj.err]),
      },
      handler: rec.handler,
      allowStaleOnError: false,
      cacheOpts: {},
    },
  )

  h.onConnect(() => {})
  h.onHeaders(
    304,
    {
      'cache-control': 'max-age=60',
      get 'x-boom'() {
        throw new Error('poisoned header')
      },
    },
    () => {},
  )
  h.onComplete({})

  t.equal(rec.body(), 'cached-body', 'the original entry is served when freshening blows up')
  t.equal(sets.length, 0, 'nothing was written to the store')
  t.equal(logs[0]?.[0], 'failed to freshen cache entry', 'the failure is logged')
  t.equal(logs[0]?.[1].message, 'poisoned header', 'with the offending error')
})

test('revalidation: onComplete after a stale-if-error delivery does not double-deliver', async (t) => {
  t.plan(5)
  const rec = makeRecorder()
  const abortSpy = []
  const h = new RevalidationHandler(
    KEY,
    makeEntry(),
    {},
    {
      store: { get() {}, set() {} },
      handler: rec.handler,
      allowStaleOnError: true,
      cacheOpts: {},
    },
  )

  h.onConnect((reason) => abortSpy.push(reason))
  t.equal(
    h.onHeaders(503, {}, () => {}),
    false,
    'the error body is not drained',
  )
  t.equal(rec.body(), 'cached-body', 'the stale entry is served immediately')
  t.match(abortSpy[0]?.message, /stale-if-error/, 'the in-flight error response is aborted')

  // If the transport still completes (e.g. the abort raced an empty body),
  // the delivered guard swallows it.
  h.onComplete({})
  t.equal(rec.completes, 1, 'no second delivery')
  t.equal(rec.errors.length, 0, 'and no spurious error')
})

// ---------------------------------------------------------------------------
// backgroundRefresh: vary-less entries, in-flight bookkeeping, failure paths
// ---------------------------------------------------------------------------

test('backgroundRefresh: refreshes a vary-less entry and stores the replacement', async (t) => {
  t.plan(5)
  let hits = 0
  const seenHeaders = []
  const server = await startServer((req, res) => {
    hits++
    seenHeaders.push(req.headers)
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('fresh-body')
  })
  t.teardown(server.close.bind(server))

  const now = Date.now()
  const sets = []
  const buf = Buffer.from('stale-body')
  // A store whose entry has NO vary field at all (a legal custom store):
  // the refresh key must tolerate it.
  const store = {
    get: () => ({
      body: buf,
      start: 0,
      end: buf.byteLength,
      statusCode: 200,
      statusMessage: '',
      headers: { 'cache-control': 'max-age=1, stale-while-revalidate=60' },
      cacheControlDirectives: { 'max-age': 1, 'stale-while-revalidate': 60 },
      etag: '"v1"',
      cachedAt: now - 10e3,
      staleAt: now - 5e3,
      deleteAt: now + 3600e3,
    }),
    set: (key, value) => {
      sets.push(value)
    },
  }
  const dispatch = makeDispatch()
  const opts = { origin: origin(server), path: '/', method: 'GET', headers: {}, cache: { store } }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.body, 'stale-body', 'the stale entry is served immediately')

  await waitFor(() => sets.length === 1)
  t.equal(hits, 1, 'one background refresh reached the origin')
  t.equal(seenHeaders[0]['if-none-match'], '"v1"', 'the refresh is conditional')
  t.equal(sets[0].body.toString(), 'fresh-body', 'the replacement was stored')
  t.equal(sets[0].cacheControlDirectives['max-age'], 60, 'with its own directives')
})

test('backgroundRefresh: a synchronous dispatch throw is logged and releases the in-flight slot', async (t) => {
  t.plan(3)
  const logs = []
  const store = {}
  let calls = 0
  const throwingDispatch = () => {
    calls++
    throw new Error('sync-boom')
  }
  const opts = {
    headers: {},
    cache: {},
    logger: {
      debug: (obj, msg) => logs.push([msg, obj.err]),
      error: () => {},
    },
  }
  // Key without headers and entry without vary: both fallbacks must hold.
  const key = { method: 'GET', origin: 'http://bg.local', path: '/' }
  const entry = { cachedAt: Date.now() }

  backgroundRefresh(throwingDispatch, opts, key, store, entry)
  t.strictSame(
    logs.map(([msg]) => msg),
    ['cache: background revalidation failed'],
    'the throw is logged at debug',
  )

  // The slot must have been released — a second refresh attempts dispatch again.
  backgroundRefresh(throwingDispatch, opts, key, store, entry)
  t.equal(calls, 2, 'the in-flight slot was released after the throw')
  t.equal(logs[1][1].message, 'sync-boom', 'the dispatch error is what got logged')
})

test('backgroundRefresh: dedupes in-flight refreshes per variant and releases the slot on error', async (t) => {
  t.plan(6)
  const store = {}
  const handlers = []
  let calls = 0
  const hangingDispatch = (opts, handler) => {
    calls++
    handlers.push(handler)
  }
  // No logger at all: the error path must tolerate its absence.
  const opts = { headers: {}, cache: {} }
  const key = { method: 'GET', origin: 'http://bg.local', path: '/', headers: {} }
  const entryHtml = { vary: { accept: 'text/html' }, cachedAt: Date.now() }

  backgroundRefresh(hangingDispatch, opts, key, store, entryHtml)
  backgroundRefresh(hangingDispatch, opts, key, store, entryHtml)
  t.equal(calls, 1, 'a hot stale variant spawns one refresh, not a herd')

  backgroundRefresh(hangingDispatch, opts, key, store, {
    vary: { accept: 'application/json' },
    cachedAt: Date.now(),
  })
  t.equal(calls, 2, 'a different Vary variant gets its own refresh slot')

  // Fail the first refresh: the slot is released and the failure is silent.
  handlers[0].onError(new Error('refresh failed'))
  backgroundRefresh(hangingDispatch, opts, key, store, entryHtml)
  t.equal(calls, 3, 'the slot was released after the refresh error')

  // Same shape but WITH a logger: the failure is logged at debug.
  const logs = []
  const optsLogged = {
    headers: {},
    cache: {},
    logger: { debug: (obj, msg) => logs.push(msg), error: () => {} },
  }
  const failingDispatch = (o, handler) => {
    calls++
    handler.onError(new Error('immediate failure'))
  }
  const storeLogged = {}
  backgroundRefresh(failingDispatch, optsLogged, key, storeLogged, entryHtml)
  t.strictSame(logs, ['cache: background revalidation failed'], 'the refresh error is logged')
  backgroundRefresh(failingDispatch, optsLogged, key, storeLogged, entryHtml)
  t.equal(calls, 5, 'an errored refresh releases its slot for the next one')

  // Stores do not share refresh slots: the guard is per store.
  backgroundRefresh(hangingDispatch, opts, key, {}, entryHtml)
  t.equal(calls, 6, 'a different store dispatches its own refresh for the same key')
})
