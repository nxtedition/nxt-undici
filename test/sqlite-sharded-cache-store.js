import { test } from 'tap'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { SqliteShardedCacheStore } from '../lib/sqlite-sharded-cache-store.js'
import { interceptors, compose } from '../lib/index.js'
import undici from '@nxtedition/undici'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKey(overrides = {}) {
  return { origin: 'https://example.com', method: 'GET', path: '/test', ...overrides }
}

function makeValue(overrides = {}) {
  const now = Date.now()
  return {
    body: Buffer.from('hello'),
    start: 0,
    end: 5,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
    ...overrides,
  }
}

// set() is async (batched via setImmediate). Call flush() before get() to
// ensure the write has reached the database.
const flush = () => new Promise((resolve) => setImmediate(resolve))

// Opens a store and registers a best-effort teardown so it is always closed,
// even if an assertion throws before a test reaches its explicit close().
// close() is not idempotent (it mirrors the base store), so the teardown
// swallows the error from a redundant close after the test already closed.
function openStore(t, opts) {
  const store = new SqliteShardedCacheStore(opts)
  t.teardown(() => {
    try {
      store.close()
    } catch {
      // already closed by the test body — best-effort cleanup only
    }
  })
  return store
}

function makeTmpLocation(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sharded-cache-${name}-`))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'cache.db')
}

// Counts the rows in a shard database file, whatever the current schema
// version's table name is. Opens its own connection so pending WAL content is
// visible even while the store still has the file open.
function countRows(file) {
  const db = new DatabaseSync(file)
  try {
    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cacheInterceptorV%'`,
      )
      .get()
    if (!table) {
      return 0
    }
    return db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get().n
  } finally {
    db.close()
  }
}

function shardFiles(location, shards) {
  return Array.from({ length: shards }, (_, i) => `${location}.${i}-${shards}`)
}

// ---------------------------------------------------------------------------
// Constructor / options
// ---------------------------------------------------------------------------

test('defaults to 4 shards, custom shard count is respected', (t) => {
  const a = openStore(t)
  t.equal(a.shards, 4, 'default shard count is 4')

  const b = openStore(t, { shards: 2 })
  t.equal(b.shards, 2, 'custom shard count')

  const c = openStore(t, { shards: 1 })
  t.equal(c.shards, 1, 'single shard degenerates to a plain store')
  t.end()
})

test('invalid shards option throws TypeError', (t) => {
  for (const shards of [0, -1, 1.5, '4', NaN, Infinity]) {
    t.throws(() => new SqliteShardedCacheStore({ shards }), TypeError, `shards=${shards} rejected`)
  }
  // Nullish means "use the default", matching the other store options.
  const store = openStore(t, { shards: null })
  t.equal(store.shards, 4, 'shards=null falls back to the default')
  t.end()
})

test('invalid cache key throws TypeError before touching any shard', (t) => {
  const store = openStore(t)

  t.throws(() => store.get(null), TypeError, 'null key')
  t.throws(() => store.get({ origin: 'https://x.com', method: 'GET' }), TypeError, 'missing path')
  t.throws(() => store.set(undefined, makeValue()), TypeError, 'undefined key on set')
  t.end()
})

test('maxSize is split across shards and still yields workable budgets', async (t) => {
  // A total not divisible by the shard count exercises the remainder split.
  // Each shard must still receive a budget large enough to hold the schema —
  // the base store throws SQLITE_FULL on a budget of only a page or two.
  const maxSize = 8 * 1024 * 1024 + 3
  const store = openStore(t, { shards: 4, maxSize })

  for (let i = 0; i < 8; i++) {
    store.set(makeKey({ path: `/ms-${i}` }), makeValue())
  }
  await flush()

  for (let i = 0; i < 8; i++) {
    t.ok(store.get(makeKey({ path: `/ms-${i}` })), `key ${i} stored under a split budget`)
  }
  t.end()
})

test('close() is not idempotent and aggregates multiple shard failures', (t) => {
  // close() mirrors the base store, whose close() throws on a second call. A
  // second close() of a multi-shard store therefore makes every shard throw —
  // more than one error, so they are combined into an AggregateError rather
  // than all but the first being swallowed.
  const multi = openStore(t, { shards: 3 })
  multi.close()
  t.throws(() => multi.close(), AggregateError, 'multiple shard errors are aggregated')

  // A single shard produces a single error, surfaced as-is (not wrapped).
  const single = openStore(t, { shards: 1 })
  single.close()
  let lone
  try {
    single.close()
  } catch (err) {
    lone = err
  }
  t.ok(lone instanceof Error, 'a lone shard failure throws')
  t.notOk(lone instanceof AggregateError, 'a lone shard error is surfaced unwrapped')
  t.end()
})

// ---------------------------------------------------------------------------
// Basic semantics through the shard router
// ---------------------------------------------------------------------------

test('basic set/get round-trip across many keys (memory)', async (t) => {
  const store = openStore(t)

  const now = Date.now()
  for (let i = 0; i < 16; i++) {
    store.set(
      makeKey({ path: `/rt-${i}` }),
      makeValue({ body: Buffer.from(`body-${i}`), end: 5 + String(i).length, cachedAt: now }),
    )
  }

  t.ok(store.get(makeKey({ path: '/rt-0' })), 'visible in batch before flush')
  await flush()

  for (let i = 0; i < 16; i++) {
    const result = store.get(makeKey({ path: `/rt-${i}` }))
    t.ok(result, `key ${i} present after flush`)
    t.equal(result.body.toString(), `body-${i}`, `key ${i} body intact`)
  }
  t.end()
})

test('vary matching passes through the router', async (t) => {
  const store = openStore(t)

  store.set(
    makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )
  await flush()

  t.ok(
    store.get(makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } })),
    'vary match hits',
  )
  t.equal(
    store.get(makeKey({ path: '/vary', headers: { 'accept-encoding': 'br' } })),
    undefined,
    'vary mismatch misses',
  )
  t.end()
})

// ---------------------------------------------------------------------------
// Sharding behavior (file-backed)
// ---------------------------------------------------------------------------

test('creates one database file per shard and spreads keys across all of them', async (t) => {
  const location = makeTmpLocation(t, 'spread')
  const store = openStore(t, { location, shards: 4 })

  for (let i = 0; i < 64; i++) {
    store.set(makeKey({ path: `/spread-${i}` }), makeValue())
  }
  await flush()
  store.close()

  const counts = shardFiles(location, 4).map((file) => {
    t.ok(fs.existsSync(file), `${path.basename(file)} exists`)
    return countRows(file)
  })

  t.equal(
    counts.reduce((a, b) => a + b, 0),
    64,
    'all entries landed exactly once',
  )
  for (const [i, n] of counts.entries()) {
    // With 64 distinct URLs over 4 shards, P(empty shard) ~ 4 * (3/4)^64 ~ 4e-8.
    t.ok(n > 0, `shard ${i} received entries (${n})`)
  }
  t.end()
})

test('URL routing is deterministic across store instances (same location, same shards)', async (t) => {
  const location = makeTmpLocation(t, 'stable')

  const writer = openStore(t, { location, shards: 4 })
  for (let i = 0; i < 32; i++) {
    writer.set(
      makeKey({ path: `/stable-${i}` }),
      makeValue({ body: Buffer.from(`v${i}`), end: 1 + String(i).length }),
    )
  }
  await flush()
  writer.close()

  // A fresh instance — as another process would — must route every URL to the
  // shard the writer picked.
  const reader = openStore(t, { location, shards: 4 })
  for (let i = 0; i < 32; i++) {
    const result = reader.get(makeKey({ path: `/stable-${i}` }))
    t.ok(result, `key ${i} found by second instance`)
    t.equal(result.body.toString(), `v${i}`, `key ${i} body intact`)
  }
  t.end()
})

test('changing the shard count uses a fresh, disjoint set of files', async (t) => {
  const location = makeTmpLocation(t, 'recount')

  const four = openStore(t, { location, shards: 4 })
  for (let i = 0; i < 8; i++) {
    four.set(makeKey({ path: `/recount-${i}` }), makeValue())
  }
  await flush()
  four.close()

  // A different count must not read rows placed under an incompatible
  // URL→shard mapping — the count is part of the filename, so it starts
  // from an empty, disjoint file set.
  const two = openStore(t, { location, shards: 2 })
  for (let i = 0; i < 8; i++) {
    t.equal(
      two.get(makeKey({ path: `/recount-${i}` })),
      undefined,
      `key ${i} not visible under a different shard count`,
    )
  }
  for (const file of shardFiles(location, 2)) {
    t.ok(fs.existsSync(file), `${path.basename(file)} created for the new count`)
  }
  t.equal(
    shardFiles(location, 4).reduce((sum, file) => sum + countRows(file), 0),
    8,
    'the old cohort files are left untouched',
  )
  t.end()
})

test('close() drains pending batches of every shard', async (t) => {
  const location = makeTmpLocation(t, 'drain')

  const store = openStore(t, { location, shards: 4 })
  for (let i = 0; i < 16; i++) {
    store.set(makeKey({ path: `/drain-${i}` }), makeValue())
  }
  // No flush await — close() must drain synchronously.
  store.close()

  const total = shardFiles(location, 4).reduce((sum, file) => sum + countRows(file), 0)
  t.equal(total, 16, 'all pending entries were flushed on close')
  t.end()
})

test('clear() empties every shard', async (t) => {
  const location = makeTmpLocation(t, 'clear')
  const store = openStore(t, { location, shards: 4 })

  for (let i = 0; i < 16; i++) {
    store.set(makeKey({ path: `/clear-${i}` }), makeValue())
  }
  await flush()
  store.clear()

  for (let i = 0; i < 16; i++) {
    t.equal(store.get(makeKey({ path: `/clear-${i}` })), undefined, `key ${i} gone`)
  }
  const total = shardFiles(location, 4).reduce((sum, file) => sum + countRows(file), 0)
  t.equal(total, 0, 'no rows remain in any shard')
  t.end()
})

test('gc() removes expired entries from every shard', async (t) => {
  const location = makeTmpLocation(t, 'gc')
  const store = openStore(t, { location, shards: 4 })

  const now = Date.now()
  for (let i = 0; i < 16; i++) {
    store.set(
      makeKey({ path: `/gc-expired-${i}` }),
      makeValue({ cachedAt: now - 20000, staleAt: now - 15000, deleteAt: now - 10000 }),
    )
    store.set(makeKey({ path: `/gc-live-${i}` }), makeValue())
  }
  await flush()

  const files = shardFiles(location, 4)
  t.equal(
    files.reduce((sum, file) => sum + countRows(file), 0),
    32,
    'expired and live rows all flushed',
  )

  store.gc()

  t.equal(
    files.reduce((sum, file) => sum + countRows(file), 0),
    16,
    'gc dropped the expired rows in every shard',
  )
  for (let i = 0; i < 16; i++) {
    t.ok(store.get(makeKey({ path: `/gc-live-${i}` })), `live key ${i} survived gc`)
  }
  t.end()
})

test('nxt:clearCache broadcast reaches all shards', async (t) => {
  const store = openStore(t)

  for (let i = 0; i < 8; i++) {
    store.set(makeKey({ path: `/bc-${i}` }), makeValue())
  }
  await flush()
  t.ok(store.get(makeKey({ path: '/bc-0' })), 'entry present before broadcast')

  const bc = new BroadcastChannel('nxt:clearCache')
  t.teardown(() => bc.close())
  bc.postMessage(null)

  // Delivery is async; poll with a bounded deadline.
  const deadline = Date.now() + 2000
  while (store.get(makeKey({ path: '/bc-0' })) !== undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  for (let i = 0; i < 8; i++) {
    t.equal(store.get(makeKey({ path: `/bc-${i}` })), undefined, `key ${i} cleared`)
  }
  t.end()
})

// ---------------------------------------------------------------------------
// Integration with the cache interceptor
// ---------------------------------------------------------------------------

test('cache interceptor serves second request from a sharded store', async (t) => {
  t.plan(2)
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
    res.end('sharded body')
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const store = openStore(t)
  const dispatch = compose(new undici.Agent(), interceptors.cache())
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  const rawRequest = () =>
    new Promise((resolve, reject) => {
      const chunks = []
      dispatch(opts, {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData(chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        },
        onComplete() {
          resolve(Buffer.concat(chunks).toString())
        },
        onError: reject,
      })
    })

  const first = await rawRequest()
  const second = await rawRequest()

  t.equal(hits, 1, 'server hit only once')
  t.equal(second, first, 'cached body served intact')
})

test('cache interceptor caches via its default store when none is provided', async (t) => {
  t.plan(2)
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
    res.end('default store body')
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.cache())
  // No cache.store — exercises the interceptor's default (now a sharded store).
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/default-store',
    method: 'GET',
    headers: {},
    cache: {},
  }

  const rawRequest = () =>
    new Promise((resolve, reject) => {
      const chunks = []
      dispatch(opts, {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData(chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        },
        onComplete() {
          resolve(Buffer.concat(chunks).toString())
        },
        onError: reject,
      })
    })

  const first = await rawRequest()
  const second = await rawRequest()

  t.equal(hits, 1, 'server hit only once (served from the default store)')
  t.equal(second, first, 'cached body served intact')
})
