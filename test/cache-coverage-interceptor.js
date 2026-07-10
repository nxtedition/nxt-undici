/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import { CacheHandler } from '../lib/interceptor/cache/cache-handler.js'
import { serveFromCache } from '../lib/interceptor/cache/serve.js'
import { isEtagUsable } from '../lib/interceptor/cache/headers.js'
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
    let responseHeaders
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc, headers) {
        statusCode = sc
        responseHeaders = headers
        return true
      },
      onData() {},
      onComplete() {
        resolve({ statusCode, headers: responseHeaders })
      },
      onError: reject,
    })
  })
}

function rawRequestWithBody(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    let responseHeaders
    const chunks = []
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc, headers) {
        statusCode = sc
        responseHeaders = headers
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      },
      onComplete() {
        resolve({ statusCode, headers: responseHeaders, body: Buffer.concat(chunks).toString() })
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
  return `http://127.0.0.1:${server.address().port}`
}

// Recording fake store: always misses, records every set/delete.
function makeRecordingStore() {
  return {
    sets: [],
    deletes: [],
    get() {
      return undefined
    },
    set(key, value) {
      this.sets.push({ key, value })
    },
    delete(key) {
      this.deletes.push(key)
    },
  }
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

// Minimal inner handler for driving CacheHandler / serveFromCache directly.
function makeInnerHandler() {
  const events = []
  return {
    events,
    onConnect() {
      events.push(['connect'])
    },
    onHeaders(sc, headers) {
      events.push(['headers', sc, headers])
      return true
    },
    onData(chunk) {
      events.push(['data', chunk])
      return true
    },
    onComplete(trailers) {
      events.push(['complete', trailers])
    },
    onError(err) {
      events.push(['error', err])
    },
  }
}

// Bounded poll — never waits forever.
async function waitFor(cond, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

// ---------------------------------------------------------------------------
// determineAge: Age header list/array forms
// ---------------------------------------------------------------------------

test('cache: duplicated Age header lines (array) use the first value', async (t) => {
  const server = await startServer((req, res) => {
    res.setHeader('Age', ['1200', '3'])
    res.setHeader('Cache-Control', 'max-age=3600')
    res.end('x')
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const dispatch = makeDispatch()
  await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  })

  t.equal(store.sets.length, 1, 'entry stored')
  const { value } = store.sets[0]
  const backdatedMs = Date.now() - value.cachedAt
  t.ok(backdatedMs >= 1200e3, `cachedAt backdated by the first Age value (${backdatedMs}ms)`)
  t.ok(backdatedMs < 1210e3, 'not backdated by more than the first Age value')
  t.equal(value.staleAt - value.cachedAt, 3600e3, 'freshness measured from backdated cachedAt')
  t.ok(!('age' in value.headers), 'origin Age header stripped from stored headers')
})

test('cache: Age list value "1200, 0" uses the first member', async (t) => {
  const server = await startServer((req, res) => {
    res.setHeader('Age', '1200, 0')
    res.setHeader('Cache-Control', 'max-age=3600')
    res.end('x')
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const dispatch = makeDispatch()
  await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  })

  t.equal(store.sets.length, 1, 'entry stored')
  const { value } = store.sets[0]
  const backdatedMs = Date.now() - value.cachedAt
  t.ok(backdatedMs >= 1200e3, `cachedAt backdated by the first list member (${backdatedMs}ms)`)
  t.ok(backdatedMs < 1210e3, 'the second (smaller) list member did not win')
})

// ---------------------------------------------------------------------------
// determineLifetime: Expires edge shapes
// ---------------------------------------------------------------------------

test('cache: duplicated Expires header lines mean already expired (not stored)', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.setHeader('Expires', ['Thu, 01 Jan 1970 00:00:01 GMT', 'Thu, 01 Jan 1970 00:00:02 GMT'])
    res.end('x')
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const dispatch = makeDispatch()
  const opts = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }
  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)

  t.equal(store.sets.length, 0, 'nothing stored')
  t.equal(hits, 2, 'both requests reached the origin')
})

test('cache: Expires without a Date header measures lifetime from receipt time', async (t) => {
  const server = await startServer((req, res) => {
    res.sendDate = false
    res.setHeader('Expires', new Date(Date.now() + 60_000).toUTCString())
    res.end('x')
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const dispatch = makeDispatch()
  await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  })

  t.equal(store.sets.length, 1, 'entry stored')
  const { value } = store.sets[0]
  const lifetimeMs = value.staleAt - value.cachedAt
  t.ok(lifetimeMs >= 55e3 && lifetimeMs <= 61e3, `lifetime computed from now (${lifetimeMs}ms)`)
})

test('cache: Expires with a Date header measures lifetime from the origin Date', async (t) => {
  const server = await startServer((req, res) => {
    const now = Date.now()
    res.setHeader('Date', new Date(now).toUTCString())
    res.setHeader('Expires', new Date(now + 60_000).toUTCString())
    res.end('x')
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const dispatch = makeDispatch()
  await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  })

  t.equal(store.sets.length, 1, 'entry stored')
  const { value } = store.sets[0]
  const lifetimeMs = value.staleAt - value.cachedAt
  t.ok(lifetimeMs >= 58e3 && lifetimeMs <= 61e3, `lifetime is Expires minus Date (${lifetimeMs}ms)`)
})

// ---------------------------------------------------------------------------
// computeEntryTimes edges
// ---------------------------------------------------------------------------

test('cache: non-finite lifetime (defaultTTL Infinity) is not stored', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.end('x') // no caching headers at all
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()

  const infStore = makeRecordingStore()
  const infOpts = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store: infStore, defaultTTL: Infinity },
  }
  await rawRequest(dispatch, infOpts)
  await rawRequest(dispatch, infOpts)
  t.equal(infStore.sets.length, 0, 'Infinity defaultTTL stores nothing')
  t.equal(hits, 2, 'both requests reached the origin')

  // Control: a finite defaultTTL DOES store — proving the skip above is the
  // non-finite lifetime, not "no lifetime info".
  const finStore = makeRecordingStore()
  await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store: finStore, defaultTTL: 60 },
  })
  t.equal(finStore.sets.length, 1, 'finite defaultTTL stores')
})

test('cache: stale-if-error response directive extends retention', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 'max-age=1, stale-if-error=300' })
    res.end('x')
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const dispatch = makeDispatch()
  await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  })

  t.equal(store.sets.length, 1, 'entry stored')
  const { value } = store.sets[0]
  t.equal(value.staleAt - value.cachedAt, 1e3, 'freshness is max-age')
  t.equal(
    value.deleteAt - value.cachedAt,
    301e3,
    'retention extended to freshness + stale-if-error',
  )
})

test('cache: retention capped by maxEntryTTL already consumed by Age is not stored', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 'max-age=5',
      age: '100',
      etag: '"v1"',
    })
    res.end('x')
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const dispatch = makeDispatch()
  const opts = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store, maxEntryTTL: 10 },
  }
  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)

  t.equal(store.sets.length, 0, 'deleteAt would already be in the past — nothing stored')
  t.equal(hits, 2, 'both requests reached the origin')
})

// ---------------------------------------------------------------------------
// parseVary: empty member skipped
// ---------------------------------------------------------------------------

test('cache: Vary with a trailing comma skips the empty member', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 'max-age=60', vary: 'x-select,' })
    res.end('x')
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const dispatch = makeDispatch()
  await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'x-select': 'a' },
    cache: { store },
  })

  t.equal(store.sets.length, 1, 'entry stored')
  const { value } = store.sets[0]
  t.strictSame(Object.keys(value.vary), ['x-select'], 'no spurious empty-string selector')
  t.equal(value.vary['x-select'], 'a', 'request value recorded for the real selector')
})

// ---------------------------------------------------------------------------
// CacheHandler store-time header stripping
// ---------------------------------------------------------------------------

test('cache: duplicated Connection header lines strip every listed field', async (t) => {
  // Duplicated Connection response lines arrive as an array through
  // parseHeaders; node's http server can't easily emit them, so drive the
  // exported CacheHandler directly the way the dispatch chain would.
  const store = makeRecordingStore()
  const inner = makeInnerHandler()
  const handler = new CacheHandler(
    { origin: 'http://example.local', path: '/', method: 'GET', headers: {} },
    { store, handler: inner },
  )

  handler.onConnect(() => {})
  handler.onHeaders(
    200,
    {
      'cache-control': 'max-age=60',
      connection: ['x-a, x-b', 'x-c'],
      'x-a': '1',
      'x-b': '2',
      'x-c': '3',
      'x-keep': 'k',
    },
    () => {},
  )
  handler.onData(Buffer.from('body'))
  handler.onComplete(null)

  t.equal(store.sets.length, 1, 'entry stored')
  const stored = store.sets[0].value.headers
  t.ok(!('connection' in stored), 'connection (hop-by-hop) stripped')
  t.ok(!('x-a' in stored), 'field from first Connection line stripped')
  t.ok(!('x-b' in stored), 'second field from first Connection line stripped')
  t.ok(!('x-c' in stored), 'field from second Connection line stripped')
  t.equal(stored['x-keep'], 'k', 'unlisted field kept')
})

test('cache: qualified private="field" strips the field at store time', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 'max-age=60, private="x-secret"',
      'x-secret': 'sst',
      'x-public': 'pub',
    })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts)
  const second = await rawRequestWithBody(dispatch, opts)

  t.equal(hits, 1, 'second request served from cache')
  t.equal(second.body, 'body')
  t.equal(second.headers['x-public'], 'pub', 'unlisted header replayed')
  t.equal(second.headers['x-secret'], undefined, 'private-listed header never stored')
})

// ---------------------------------------------------------------------------
// CacheHandler onComplete: unannounced trailers decline storage
// ---------------------------------------------------------------------------

test('cache: response with unannounced trailers is not stored', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.write('hello')
    res.addTrailers({ 'x-trail': 'v' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const writer = makeWriter()
  const dispatch = makeDispatch()
  const opts = {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
    trace: writer,
  }

  await rawRequest(dispatch, opts)
  await rawRequest(dispatch, opts)

  t.equal(store.sets.length, 0, 'nothing stored')
  t.equal(hits, 2, 'both requests reached the origin')

  const storeDocs = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(storeDocs.length, 2, 'one cache-store doc per response')
  for (const doc of storeDocs) {
    t.equal(doc.stored, false)
    t.equal(doc.reason, 'trailer')
  }
})

// ---------------------------------------------------------------------------
// InvalidationHandler error paths
// ---------------------------------------------------------------------------

test('cache: throwing store.delete on invalidation is swallowed and logged', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(204)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()

  // Generic error → logger.error, and the trace doc carries the error tag.
  {
    const logged = []
    const writer = makeWriter()
    const store = {
      get() {},
      set() {},
      delete() {
        throw new Error('boom')
      },
    }
    const { statusCode } = await rawRequest(dispatch, {
      origin: origin(server),
      path: '/thing',
      method: 'POST',
      headers: {},
      cache: { store },
      logger: {
        error(obj) {
          logged.push(['error', obj.err.message])
        },
        debug(obj) {
          logged.push(['debug', obj.err.message])
        },
      },
      trace: writer,
    })
    t.equal(statusCode, 204, 'invalidation failure never breaks the response')
    t.strictSame(logged, [['error', 'boom']], 'generic delete error logged at error level')

    const docs = writer.docs.filter((doc) => doc.op === 'undici:cache-invalidate')
    t.equal(docs.length, 1, 'one invalidate doc')
    t.equal(docs[0].paths, 0, 'no path invalidated')
    t.type(docs[0].err, 'string')
    t.ok(docs[0].err.length > 0, 'error tagged on the doc')
  }

  // 'database is locked' → logger.debug.
  {
    const logged = []
    const store = {
      get() {},
      set() {},
      delete() {
        throw new Error('database is locked')
      },
    }
    const { statusCode } = await rawRequest(dispatch, {
      origin: origin(server),
      path: '/thing',
      method: 'POST',
      headers: {},
      cache: { store },
      logger: {
        error(obj) {
          logged.push(['error', obj.err.message])
        },
        debug(obj) {
          logged.push(['debug', obj.err.message])
        },
      },
    })
    t.equal(statusCode, 204)
    t.strictSame(logged, [['debug', 'database is locked']], 'busy database logged at debug level')
  }
})

test('cache: store without a delete function bypasses invalidation', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(204)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = { get() {}, set() {} } // no delete
  const dispatch = makeDispatch()
  const { statusCode } = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/thing',
    method: 'POST',
    headers: {},
    cache: { store },
    trace: writer,
  })

  t.equal(statusCode, 204, 'response passes through untouched')
  t.strictSame(
    writer.docs.filter((doc) => doc.op === 'undici:cache-invalidate'),
    [],
    'no invalidation attempted (and no doc emitted)',
  )
})

test('cache: unparseable Location header is skipped during invalidation', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(204, { location: 'http://' }) // scheme-only: new URL() throws
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = makeRecordingStore()
  const writer = makeWriter()
  const dispatch = makeDispatch()
  const { statusCode } = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/thing',
    method: 'POST',
    headers: {},
    cache: { store },
    trace: writer,
  })

  t.equal(statusCode, 204)
  t.equal(store.deletes.length, 1, 'only the target URI invalidated')
  t.equal(store.deletes[0].path, '/thing')

  const docs = writer.docs.filter((doc) => doc.op === 'undici:cache-invalidate')
  t.equal(docs.length, 1)
  t.equal(docs[0].paths, 1, 'the bad Location did not count as a path')
  t.equal(docs[0].err, null)
})

test('cache: invalidation trace doc tolerates a key without a method', async (t) => {
  // A custom dispatch fn (the interceptor contract) doesn't require
  // opts.method the way the real Agent does — the trace tagging must not
  // assume it is present.
  const writer = makeWriter()
  const store = makeRecordingStore()
  const wrapped = interceptors.cache()((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(204, {}, () => {})
    handler.onComplete([])
    return true
  })

  wrapped(
    {
      origin: 'http://fake-origin',
      path: '/x',
      headers: {},
      cache: { store },
      trace: writer,
    },
    makeInnerHandler(),
  )

  t.equal(store.deletes.length, 1, 'target URI invalidated')
  const docs = writer.docs.filter((doc) => doc.op === 'undici:cache-invalidate')
  t.equal(docs.length, 1)
  t.equal(docs[0].method, null, 'absent method tagged as null')
  t.equal(docs[0].url, 'http://fake-origin/x')
  t.equal(docs[0].paths, 1)
  t.equal(docs[0].err, null)
})

// ---------------------------------------------------------------------------
// makeKey: query folding with an empty path
// ---------------------------------------------------------------------------

test('cache: opts.query with an empty path folds onto "/"', async (t) => {
  const store = makeRecordingStore()
  const wrapped = interceptors.cache()((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, { 'cache-control': 'max-age=60' }, () => {})
    handler.onData(Buffer.from('x'))
    handler.onComplete(null)
    return true
  })

  wrapped(
    {
      origin: 'http://fake-origin',
      path: '',
      method: 'GET',
      headers: {},
      query: { a: '1' },
      cache: { store },
    },
    makeInnerHandler(),
  )

  t.equal(store.sets.length, 1, 'entry stored')
  t.equal(store.sets[0].key.path, '/?a=1', 'empty path normalized to / before the query')
})

// ---------------------------------------------------------------------------
// makeKey: origin normalization (RFC 9110 §4.2.3)
// ---------------------------------------------------------------------------

// Fake dispatch that always "misses" through to a recording store, so the
// stored key.origin exposes exactly what makeKey canonicalized on both the get
// (store.get) and set (store.set) paths — they share one makeKey, so equal set
// keys imply equal get keys.
function driveOrigin(origin, store) {
  const wrapped = interceptors.cache()((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, { 'cache-control': 'max-age=60' }, () => {})
    handler.onData(Buffer.from('x'))
    handler.onComplete(null)
    return true
  })
  wrapped({ origin, path: '/', method: 'GET', headers: {}, cache: { store } }, makeInnerHandler())
}

test('cache: makeKey canonicalizes equivalent origins onto one key', async (t) => {
  // Every spelling of the same target URI must key identically: default port
  // spelled out, scheme/host case, and a URL object (toString appends "/").
  const equivalents = [
    'https://example.com',
    'https://example.com:443',
    'HTTPS://EXAMPLE.COM',
    'https://Example.Com:443',
    new URL('https://example.com'),
  ]
  for (const origin of equivalents) {
    const store = makeRecordingStore()
    driveOrigin(origin, store)
    t.equal(store.sets.length, 1, `entry stored for ${origin}`)
    t.equal(
      store.sets[0].key.origin,
      'https://example.com',
      `origin ${origin} normalized to https://example.com`,
    )
  }
})

test('cache: makeKey preserves non-default ports and distinct hosts', async (t) => {
  const cases = [
    ['https://example.com:8443', 'https://example.com:8443'],
    ['http://example.com:8080', 'http://example.com:8080'],
    // http default port elided, but https on the same host stays distinct.
    ['http://example.com:80', 'http://example.com'],
  ]
  for (const [origin, expected] of cases) {
    const store = makeRecordingStore()
    driveOrigin(origin, store)
    t.equal(store.sets[0].key.origin, expected, `${origin} -> ${expected}`)
  }
})

// ---------------------------------------------------------------------------
// Trace-gated read-path branches
// ---------------------------------------------------------------------------

test('cache: if-range request bypasses the cache and emits a bypass doc', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const { statusCode } = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'if-range': '"abc"' },
    cache: { store },
    trace: writer,
  })

  t.equal(statusCode, 200)
  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 1)
  t.equal(lookups[0].result, 'bypass')
  t.equal(lookups[0].reason, 'conditional')
  t.equal(lookups[0].statusCode, null)
})

// A store holding a stale 206 range entry. SqliteCacheStore never returns a
// 206 for a rangeless request (matchesValue), so a fake store exercises the
// interceptor's own 206 gate directly.
function makeStale206Store() {
  const now = Date.now()
  const entry = {
    body: Buffer.from('part'),
    start: 0,
    end: 4,
    statusCode: 206,
    statusMessage: '',
    headers: { 'content-range': 'bytes 0-3/8', etag: '"p1"' },
    cacheControlDirectives: {},
    etag: '"p1"',
    vary: {},
    cachedAt: now - 10e3,
    staleAt: now - 5e3, // stale
    deleteAt: now + 3600e3,
  }
  return {
    sets: [],
    get() {
      return entry
    },
    set(key, value) {
      this.sets.push({ key, value })
    },
    delete() {},
  }
}

test('cache: stale 206 entry refetches in full and emits a miss doc', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('full-body')
  })
  t.teardown(server.close.bind(server))

  const store = makeStale206Store()
  const writer = makeWriter()
  const dispatch = makeDispatch()

  const first = await rawRequestWithBody(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
    trace: writer,
  })
  t.equal(first.statusCode, 200)
  t.equal(first.body, 'full-body', 'refetched in full instead of revalidating the range')
  t.equal(hits, 1)

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 1)
  t.equal(lookups[0].result, 'miss')
  t.equal(lookups[0].reason, '206')

  // The refetch is written back through the CacheHandler (no request no-store).
  t.equal(store.sets.length, 1, 'refetched 200 stored')
  t.equal(store.sets[0].value.statusCode, 200)
  t.equal(Buffer.concat(store.sets[0].value.body).toString(), 'full-body')
})

test('cache: stale 206 entry with request no-store refetches without storing', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('full-body')
  })
  t.teardown(server.close.bind(server))

  const store = makeStale206Store()
  const dispatch = makeDispatch()
  const res = await rawRequestWithBody(dispatch, {
    origin: origin(server),
    path: '/',
    method: 'GET',
    headers: { 'cache-control': 'no-store' },
    cache: { store },
  })

  t.equal(res.statusCode, 200)
  t.equal(res.body, 'full-body')
  t.equal(hits, 1)
  t.equal(store.sets.length, 0, 'refetched 200 was NOT stored (request no-store)')
})

// ---------------------------------------------------------------------------
// serveFromCache: stream request body drained on a hit
// ---------------------------------------------------------------------------

test('cache: hit with a stream request body drains the stream', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(500)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const originStr = origin(server)
  const now = Date.now()
  store.set(
    { origin: originStr, method: 'GET', path: '/', headers: {} },
    {
      body: Buffer.from('cached-body'),
      start: 0,
      end: 11,
      statusCode: 200,
      statusMessage: '',
      headers: { etag: '"s1"' },
      cacheControlDirectives: {},
      etag: '"s1"',
      vary: {},
      cachedAt: now - 1000,
      staleAt: now + 3600e3, // fresh
      deleteAt: now + 7200e3,
    },
  )

  const reqBody = new Readable({ read() {} })
  reqBody.push('request-payload')
  reqBody.push(null)

  const dispatch = makeDispatch()
  const res = await rawRequestWithBody(dispatch, {
    origin: originStr,
    path: '/',
    method: 'GET',
    headers: {},
    body: reqBody,
    cache: { store },
  })

  t.equal(res.statusCode, 200)
  t.equal(res.body, 'cached-body', 'served from cache')
  t.equal(hits, 0, 'origin never contacted')
  await waitFor(() => reqBody.readableEnded, { timeout: 500 })
  t.ok(reqBody.readableEnded, 'request body stream drained to release its resources')
})

// ---------------------------------------------------------------------------
// Exported helpers: unit-level edges
// ---------------------------------------------------------------------------

test('cache: isEtagUsable rejects non-string etags', async (t) => {
  t.equal(isEtagUsable(undefined), false)
  t.equal(isEtagUsable(null), false)
  t.equal(isEtagUsable(123), false)
  t.equal(isEtagUsable(['"a"']), false)
  t.equal(isEtagUsable('"a"'), true, 'control: a normal quoted etag is usable')
})

test('cache: serveFromCache tags absent id/method as null in the lookup doc', async (t) => {
  // serveFromCache is a cross-module export (revalidation.js drives it);
  // it must tolerate minimal opts without inventing trace tags.
  const docs = []
  const write = (obj, op) => docs.push({ ...obj, op })
  const inner = makeInnerHandler()

  serveFromCache(
    {
      statusCode: 200,
      headers: { foo: 'bar' },
      body: Buffer.from('zz'),
      cachedAt: Date.now() - 5000,
    },
    {}, // no id, no method
    inner,
    write,
    'http://u/',
    7,
  )

  t.equal(docs.length, 1)
  const doc = docs[0]
  t.equal(doc.op, 'undici:cache')
  t.equal(doc.id, null)
  t.equal(doc.method, null)
  t.equal(doc.url, 'http://u/')
  t.equal(doc.result, 'hit')
  t.equal(doc.statusCode, 200)
  t.ok(doc.ageSec >= 4 && doc.ageSec <= 6, `resident age (${doc.ageSec}s)`)
  t.equal(doc.sizeBytes, 2)
  t.equal(doc.lookupMs, 7)

  const complete = inner.events.find((e) => e[0] === 'complete')
  t.ok(complete, 'handler completed')
  const headersEvent = inner.events.find((e) => e[0] === 'headers')
  t.equal(headersEvent[2].foo, 'bar')
  t.ok(Number(headersEvent[2].age) >= 4, 'Age header recomputed from cachedAt')
})

test('cache: CacheHandler store doc tags an absent key method as null', async (t) => {
  const docs = []
  const write = (obj, op) => docs.push({ ...obj, op })
  const store = makeRecordingStore()
  const inner = makeInnerHandler()
  const handler = new CacheHandler(
    { origin: 'http://example.local', path: '/', headers: {} }, // no method
    { store, handler: inner, write, id: 'abc', url: 'http://example.local/' },
  )

  handler.onConnect(() => {})
  handler.onHeaders(404, {}, () => {})
  handler.onComplete(null)

  t.equal(store.sets.length, 0, '404 is not stored')
  t.equal(docs.length, 1, 'one cache-store doc')
  const doc = docs[0]
  t.equal(doc.op, 'undici:cache-store')
  t.equal(doc.id, 'abc')
  t.equal(doc.method, null, 'absent method tagged as null')
  t.equal(doc.stored, false)
  t.equal(doc.reason, 'status')
  t.equal(doc.statusCode, 404)
})
