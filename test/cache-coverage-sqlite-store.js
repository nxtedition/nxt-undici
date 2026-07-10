// Coverage tests for lib/sqlite-cache-store.js — targets the paths the
// existing suites leave uncovered: broadcast registry pruning of dead
// WeakRefs, schema compatibility failures, gc()/clear() error paths,
// delete() (batch + DB invalidation), within-batch coalescing, flush
// supersede semantics, flush time-budget slicing, SQLITE_FULL / non-FULL
// flush errors, findValue full-scan + sort comparator arms, matchesValue
// 206-without-range, headerValueEquals array normalization, makeResult
// batch-copy vs DB-alias body arms, and staleAt validation.
import { test } from 'tap'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import v8 from 'node:v8'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'

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

// set() is async (batched via setImmediate); one tick lets a flush run.
const flush = () => new Promise((resolve) => setImmediate(resolve))

// Poll until fn() is truthy, bounded by a deadline (never wait forever).
async function waitFor(fn, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!fn()) {
    if (Date.now() > deadline) return false
    await flush()
  }
  return true
}

function tmpDb(t, prefix) {
  const dbPath = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
  )
  t.teardown(() => {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + ext)
      } catch {}
    }
  })
  return dbPath
}

// Count rows in the current-version cache table of a CLOSED file-backed store.
function countRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cacheInterceptorV%'`,
      )
      .all()
      .map((r) => r.name)
      .find((n) => /^cacheInterceptorV\d+$/.test(n))
    if (!table) return 0
    return db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c
  } finally {
    db.close()
  }
}

function collectWarnings(t) {
  const warnings = []
  const onWarning = (w) => warnings.push(w)
  process.on('warning', onWarning)
  t.teardown(() => process.off('warning', onWarning))
  return warnings
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

test('constructor honors opts.db.timeout and maxSize with a file-backed db', async (t) => {
  const dbPath = tmpDb(t, 'ctor-opts')
  const store = new SqliteCacheStore({
    location: dbPath,
    maxSize: 1024 * 1024,
    db: { timeout: 100 },
  })
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/ctor' }), makeValue())
  await flush()
  const result = store.get(makeKey({ path: '/ctor' }))
  t.ok(result, 'store with explicit db timeout works')
  t.equal(result.body.toString(), 'hello')
  t.end()
})

// ---------------------------------------------------------------------------
// Schema compatibility preflight
// ---------------------------------------------------------------------------

test('old-version tables fail hard, prefix-sharing user tables are kept', (t) => {
  const dbPath = tmpDb(t, 'schema-mismatch')

  const seed = new DatabaseSync(dbPath)
  seed.exec(`
    CREATE TABLE cacheInterceptorV1 (id INTEGER PRIMARY KEY, url TEXT);
    INSERT INTO cacheInterceptorV1 (url) VALUES ('https://old.example.com/');
    CREATE TABLE cacheInterceptorVKeep (k TEXT PRIMARY KEY);
  `)
  seed.close()

  let error
  try {
    new SqliteCacheStore({ location: dbPath })
    t.fail('construction should reject an incompatible cache schema')
  } catch (err) {
    error = err
  }
  t.equal(error?.code, 'ERR_SQLITE_CACHE_SCHEMA_MISMATCH')

  const check = new DatabaseSync(dbPath, { readOnly: true })
  t.teardown(() => check.close())
  const tables = check
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((r) => r.name)
  t.ok(tables.includes('cacheInterceptorV1'), 'incompatible cache table preserved')
  t.ok(tables.includes('cacheInterceptorVKeep'), 'non-digit-suffix table preserved')
  t.strictSame(
    tables.filter((name) => /^cacheInterceptorV\d+$/.test(name)),
    ['cacheInterceptorV1'],
    'constructor did not create the current table',
  )
  t.end()
})

test('schema inspection errors propagate without warning-and-continue', async (t) => {
  const dbPath = tmpDb(t, 'schema-read-fail')
  const warnings = collectWarnings(t)
  const AnyDB = /** @type {any} */ (DatabaseSync)
  const origPrepare = AnyDB.prototype.prepare
  const synthetic = Object.assign(new Error('synthetic schema read failure'), { errcode: 11 })
  AnyDB.prototype.prepare = function (sql) {
    if (/FROM sqlite_master/.test(sql)) {
      throw synthetic
    }
    return origPrepare.call(this, sql)
  }

  let error
  try {
    new SqliteCacheStore({ location: dbPath })
    t.fail('construction should propagate schema inspection errors')
  } catch (err) {
    error = err
  } finally {
    AnyDB.prototype.prepare = origPrepare
  }
  await flush()
  t.equal(error, synthetic, 'the original corruption-style error is rethrown')
  t.equal(warnings.length, 0, 'constructor does not downgrade the failure to a warning')
  t.end()
})

// ---------------------------------------------------------------------------
// gc() / clear() error paths
// ---------------------------------------------------------------------------

test('gc() SQL failure emits warnings from both catch and finally-catch', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/gc-err' }), makeValue())
  await flush()

  const warnings = collectWarnings(t)

  const AnyDB = /** @type {any} */ (DatabaseSync)
  const origExec = AnyDB.prototype.exec
  AnyDB.prototype.exec = function (sql) {
    if (/busy_timeout/.test(sql)) {
      throw new Error('synthetic gc pragma failure')
    }
    return origExec.call(this, sql)
  }

  try {
    t.doesNotThrow(() => store.gc(), 'gc() swallows SQL errors')
  } finally {
    AnyDB.prototype.exec = origExec
  }

  await flush()
  const gcWarnings = warnings.filter((w) => /synthetic gc pragma failure/.test(w.message))
  t.equal(gcWarnings.length, 2, 'one warning from the body, one from the finally restore')

  // Store unaffected: the entry is still served.
  t.ok(store.get(makeKey({ path: '/gc-err' })), 'entry survives failed gc')
  t.end()
})

test('gc() purges expired rows from the database', async (t) => {
  const dbPath = tmpDb(t, 'gc-purge')
  const store = new SqliteCacheStore({ location: dbPath })

  const past = Date.now() - 120e3
  store.set(
    makeKey({ path: '/dead' }),
    makeValue({ deleteAt: past, staleAt: past, cachedAt: past - 2 }),
  )
  await flush()

  store.gc()
  store.close()
  t.equal(countRows(dbPath), 0, 'expired row physically removed by gc')
  t.end()
})

test('clear() SQL failure warns twice, drops the batch, leaves DB rows intact', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/flushed' }), makeValue())
  await flush()
  store.set(makeKey({ path: '/pending' }), makeValue())

  const warnings = collectWarnings(t)

  const AnyDB = /** @type {any} */ (DatabaseSync)
  const origExec = AnyDB.prototype.exec
  AnyDB.prototype.exec = function (sql) {
    if (/busy_timeout/.test(sql)) {
      throw new Error('synthetic clear pragma failure')
    }
    return origExec.call(this, sql)
  }

  try {
    t.doesNotThrow(() => store.clear(), 'clear() swallows SQL errors')
  } finally {
    AnyDB.prototype.exec = origExec
  }

  await flush()
  const clearWarnings = warnings.filter((w) => /synthetic clear pragma failure/.test(w.message))
  t.equal(clearWarnings.length, 2, 'one warning from the body, one from the finally restore')

  t.equal(store.get(makeKey({ path: '/pending' })), undefined, 'pending batch entry dropped')
  t.ok(store.get(makeKey({ path: '/flushed' })), 'DB row untouched because DELETE never ran')
  t.end()
})

// ---------------------------------------------------------------------------
// Broadcast channels
// ---------------------------------------------------------------------------

test('nxt:offPeak broadcast triggers gc() on live stores', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  let gcCalls = 0
  store.gc = () => {
    gcCalls++
  }

  const bc = new BroadcastChannel('nxt:offPeak')
  t.teardown(() => bc.close())
  bc.postMessage(null)

  t.ok(await waitFor(() => gcCalls > 0), 'gc() invoked via broadcast')
  t.end()
})

test('nxt:clearCache broadcast clears live stores', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/bc-clear' }), makeValue())
  await flush()
  t.ok(store.get(makeKey({ path: '/bc-clear' })), 'cached before broadcast')

  const bc = new BroadcastChannel('nxt:clearCache')
  t.teardown(() => bc.close())
  bc.postMessage(null)

  t.ok(
    await waitFor(() => store.get(makeKey({ path: '/bc-clear' })) === undefined),
    'cleared via broadcast',
  )
  t.end()
})

// ---------------------------------------------------------------------------
// close() drain semantics
// ---------------------------------------------------------------------------

test('close() with pending batch drains it synchronously (final flush)', (t) => {
  const dbPath = tmpDb(t, 'close-drain')
  const store = new SqliteCacheStore({ location: dbPath })
  // >16 entries so the (n & 0xf) === 0 budget check runs with final=true.
  for (let i = 0; i < 24; i++) {
    store.set(makeKey({ path: `/drain-${i}` }), makeValue())
  }
  store.close()

  const store2 = new SqliteCacheStore({ location: dbPath })
  t.teardown(() => store2.close())
  for (let i = 0; i < 24; i++) {
    t.ok(store2.get(makeKey({ path: `/drain-${i}` })), `entry ${i} persisted by close()`)
  }
  t.end()
})

test('operations on a closed store are safe no-ops', async (t) => {
  const store = new SqliteCacheStore()
  store.close() // empty-batch close (no final flush)

  t.equal(store.get(makeKey()), undefined, 'get() returns undefined')
  t.doesNotThrow(() => store.set(makeKey(), makeValue()), 'set() silently discards')
  t.doesNotThrow(() => store.delete(makeKey()), 'delete() is a no-op')
  t.doesNotThrow(() => store.gc(), 'gc() is a no-op')
  t.doesNotThrow(() => store.clear(), 'clear() is a no-op')
  await flush()
  t.end()
})

// ---------------------------------------------------------------------------
// delete() — RFC 9111 §4.4 invalidation
// ---------------------------------------------------------------------------

test('delete() removes DB rows and pending batch entries for the URI only', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  // Flushed rows: two methods + a vary variant for the same URI, one other URI.
  store.set(makeKey({ path: '/doomed' }), makeValue())
  store.set(makeKey({ path: '/doomed', method: 'HEAD' }), makeValue({ body: null, end: 0 }))
  store.set(
    makeKey({ path: '/doomed', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )
  store.set(makeKey({ path: '/survivor' }), makeValue())
  await flush()

  // Pending batch entry for the same URI: must be dropped from the batch too.
  store.set(makeKey({ path: '/doomed' }), makeValue({ body: Buffer.from('newer'), end: 5 }))

  store.delete(makeKey({ path: '/doomed' }))
  t.equal(store.get(makeKey({ path: '/doomed' })), undefined, 'GET row + batch entry gone')
  t.equal(store.get(makeKey({ path: '/doomed', method: 'HEAD' })), undefined, 'HEAD row gone')
  t.equal(
    store.get(makeKey({ path: '/doomed', headers: { 'accept-encoding': 'gzip' } })),
    undefined,
    'vary variant gone',
  )
  t.ok(store.get(makeKey({ path: '/survivor' })), 'other URI untouched')

  // A later flush must not resurrect the invalidated batch entry.
  await flush()
  t.equal(store.get(makeKey({ path: '/doomed' })), undefined, 'not resurrected by flush')

  t.throws(() => store.delete(42), /expected key to be object/, 'delete validates its key')
  t.end()
})

// ---------------------------------------------------------------------------
// Within-batch coalescing
// ---------------------------------------------------------------------------

test('same-tick duplicate sets coalesce to one row; last write wins', async (t) => {
  const dbPath = tmpDb(t, 'coalesce-dup')
  const store = new SqliteCacheStore({ location: dbPath })

  store.set(makeKey({ path: '/dup' }), makeValue({ body: Buffer.from('first'), end: 5 }))
  store.set(makeKey({ path: '/dup' }), makeValue({ body: Buffer.from('second'), end: 6 }))
  await flush()

  t.equal(store.get(makeKey({ path: '/dup' })).body.toString(), 'second', 'last write wins')
  store.close()
  t.equal(countRows(dbPath), 1, 'duplicate coalesced within the batch')
  t.end()
})

test('same-tick 206 sets: same window coalesces, different window coexists', async (t) => {
  const dbPath = tmpDb(t, 'coalesce-206')
  const store = new SqliteCacheStore({ location: dbPath })

  const partial = (body, start, end) =>
    makeValue({ body, start, end, statusCode: 206, statusMessage: 'Partial Content' })

  // Same window twice → coalesce, second wins.
  store.set(makeKey({ path: '/p' }), partial(Buffer.from('AAAAA'), 10, 15))
  store.set(makeKey({ path: '/p' }), partial(Buffer.from('BBBBB'), 10, 15))
  // Different window → kept.
  store.set(makeKey({ path: '/p' }), partial(Buffer.from('CCCCC'), 20, 25))
  await flush()

  t.equal(
    store.get(makeKey({ path: '/p', headers: { range: 'bytes=10-14' } })).body.toString(),
    'BBBBB',
    'same-window duplicate coalesced, last wins',
  )
  t.equal(
    store.get(makeKey({ path: '/p', headers: { range: 'bytes=20-24' } })).body.toString(),
    'CCCCC',
    'distinct window coexists',
  )
  store.close()
  t.equal(countRows(dbPath), 2, 'two windows persisted, duplicate removed')
  t.end()
})

test('same-tick 200 and 206 for one URI never coalesce with each other', async (t) => {
  const dbPath = tmpDb(t, 'coalesce-mixed')
  const store = new SqliteCacheStore({ location: dbPath })

  // 206 first, then 200 — the 200 must not swallow the 206 (and vice versa).
  store.set(
    makeKey({ path: '/mixed' }),
    makeValue({
      body: Buffer.from('part'),
      start: 10,
      end: 14,
      statusCode: 206,
      statusMessage: 'Partial Content',
    }),
  )
  store.set(makeKey({ path: '/mixed' }), makeValue({ body: Buffer.from('full!'), end: 5 }))
  await flush()

  t.equal(store.get(makeKey({ path: '/mixed' })).body.toString(), 'full!', 'full response served')
  t.equal(
    store.get(makeKey({ path: '/mixed', headers: { range: 'bytes=10-13' } })).body.toString(),
    'part',
    '206 window still served',
  )
  store.close()
  t.equal(countRows(dbPath), 2, 'both representations persisted')
  t.end()
})

test('same-tick sets with different vary keep both variants', async (t) => {
  const dbPath = tmpDb(t, 'coalesce-vary')
  const store = new SqliteCacheStore({ location: dbPath })

  store.set(
    makeKey({ path: '/v', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ body: Buffer.from('gzip!'), end: 5, vary: { 'accept-encoding': 'gzip' } }),
  )
  store.set(
    makeKey({ path: '/v', headers: { 'accept-encoding': 'br' } }),
    makeValue({ body: Buffer.from('brotl'), end: 5, vary: { 'accept-encoding': 'br' } }),
  )
  await flush()

  t.equal(
    store.get(makeKey({ path: '/v', headers: { 'accept-encoding': 'gzip' } })).body.toString(),
    'gzip!',
  )
  t.equal(
    store.get(makeKey({ path: '/v', headers: { 'accept-encoding': 'br' } })).body.toString(),
    'brotl',
  )
  store.close()
  t.equal(countRows(dbPath), 2, 'different vary variants not coalesced')
  t.end()
})

// ---------------------------------------------------------------------------
// Supersede-on-flush
// ---------------------------------------------------------------------------

test('re-cache across flushes supersedes the old full row (no accumulation)', async (t) => {
  const dbPath = tmpDb(t, 'supersede-full')
  const store = new SqliteCacheStore({ location: dbPath })

  store.set(makeKey({ path: '/s' }), makeValue({ body: Buffer.from('old__'), end: 5 }))
  await flush()
  store.set(makeKey({ path: '/s' }), makeValue({ body: Buffer.from('new__'), end: 5 }))
  await flush()

  t.equal(store.get(makeKey({ path: '/s' })).body.toString(), 'new__', 'replacement served')
  store.close()
  t.equal(countRows(dbPath), 1, 'old row superseded, not accumulated')
  t.end()
})

test('receipt order beats cachedAt: replacement with OLDER cachedAt still wins', async (t) => {
  const dbPath = tmpDb(t, 'supersede-backdate')
  const store = new SqliteCacheStore({ location: dbPath })

  const now = Date.now()
  store.set(
    makeKey({ path: '/bd' }),
    makeValue({ body: Buffer.from('stale'), end: 5, cachedAt: now }),
  )
  await flush()
  // Backdated cachedAt (e.g. corrected initial age via a relay's Age header).
  store.set(
    makeKey({ path: '/bd' }),
    makeValue({ body: Buffer.from('fresh'), end: 5, cachedAt: now - 60e3 }),
  )
  await flush()

  t.equal(store.get(makeKey({ path: '/bd' })).body.toString(), 'fresh', 'newest write wins')
  store.close()
  t.equal(countRows(dbPath), 1)
  t.end()
})

test('206 supersedes only its exact window; 200 never supersedes a 206', async (t) => {
  const dbPath = tmpDb(t, 'supersede-206')
  const store = new SqliteCacheStore({ location: dbPath })

  const partial = (body, start, end) =>
    makeValue({ body, start, end, statusCode: 206, statusMessage: 'Partial Content' })

  store.set(makeKey({ path: '/w' }), partial(Buffer.from('AAAAA'), 10, 15))
  await flush()
  // Same window re-cached → replaces.
  store.set(makeKey({ path: '/w' }), partial(Buffer.from('BBBBB'), 10, 15))
  await flush()
  // Different window → coexists.
  store.set(makeKey({ path: '/w' }), partial(Buffer.from('CCCCC'), 20, 25))
  await flush()
  // Full 200 → must not delete the partials.
  store.set(makeKey({ path: '/w' }), makeValue({ body: Buffer.from('FULL!'), end: 5 }))
  await flush()

  t.equal(
    store.get(makeKey({ path: '/w', headers: { range: 'bytes=10-14' } })).body.toString(),
    'BBBBB',
    '206 window replaced by its re-cache',
  )
  t.equal(
    store.get(makeKey({ path: '/w', headers: { range: 'bytes=20-24' } })).body.toString(),
    'CCCCC',
    'other 206 window survived',
  )
  t.equal(store.get(makeKey({ path: '/w' })).body.toString(), 'FULL!', '200 served for plain GET')
  store.close()
  t.equal(countRows(dbPath), 3, 'two windows + one full row')
  t.end()
})

test('supersede is vary-scoped: re-cache of one variant keeps the other', async (t) => {
  const dbPath = tmpDb(t, 'supersede-vary')
  const store = new SqliteCacheStore({ location: dbPath })

  store.set(
    makeKey({ path: '/sv', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ body: Buffer.from('gzip1'), end: 5, vary: { 'accept-encoding': 'gzip' } }),
  )
  store.set(
    makeKey({ path: '/sv', headers: { 'accept-encoding': 'br' } }),
    makeValue({ body: Buffer.from('br__1'), end: 5, vary: { 'accept-encoding': 'br' } }),
  )
  await flush()
  store.set(
    makeKey({ path: '/sv', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ body: Buffer.from('gzip2'), end: 5, vary: { 'accept-encoding': 'gzip' } }),
  )
  await flush()

  t.equal(
    store.get(makeKey({ path: '/sv', headers: { 'accept-encoding': 'gzip' } })).body.toString(),
    'gzip2',
    'gzip variant replaced',
  )
  t.equal(
    store.get(makeKey({ path: '/sv', headers: { 'accept-encoding': 'br' } })).body.toString(),
    'br__1',
    'br variant untouched',
  )
  store.close()
  t.equal(countRows(dbPath), 2)
  t.end()
})

// ---------------------------------------------------------------------------
// Flush: time-budget slicing and error handling
// ---------------------------------------------------------------------------

test('flush slices a large batch across ticks when the time budget is hit', async (t) => {
  const store = new SqliteCacheStore()
  const origNow = performance.now.bind(performance)
  t.teardown(() => {
    delete performance.now
    store.close()
  })

  // Inflate elapsed time: every call advances 20ms beyond real time, so the
  // budget check at n=16 sees > 10ms and breaks, rescheduling the remainder.
  let bump = 0
  performance.now = () => origNow() + (bump += 20)

  for (let i = 0; i < 20; i++) {
    store.set(makeKey({ path: `/slice-${i}` }), makeValue())
  }

  await flush() // first slice (16 entries) + reschedule
  await flush() // second slice (remaining 4)
  delete performance.now

  for (let i = 0; i < 20; i++) {
    t.ok(store.get(makeKey({ path: `/slice-${i}` })), `entry ${i} eventually flushed`)
  }
  t.end()
})

test('SQLITE_FULL during flush evicts and retries successfully', async (t) => {
  const AnyDB = /** @type {any} */ (DatabaseSync)
  const origExec = AnyDB.prototype.exec

  let failed = false
  AnyDB.prototype.exec = function (sql) {
    if (sql === 'BEGIN' && !failed) {
      failed = true
      throw Object.assign(new Error('disk or database is full'), { errcode: 13 })
    }
    return origExec.call(this, sql)
  }

  const store = new SqliteCacheStore()
  t.teardown(() => {
    AnyDB.prototype.exec = origExec
    store.close()
  })

  store.set(makeKey({ path: '/full-retry' }), makeValue())
  await flush()
  await flush()
  AnyDB.prototype.exec = origExec

  t.ok(store.get(makeKey({ path: '/full-retry' })), 'entry stored after eviction retry')
  t.end()
})

test('non-SQLITE_FULL flush error drops the batch and warns exactly once', async (t) => {
  const warnings = collectWarnings(t)

  const AnyDB = /** @type {any} */ (DatabaseSync)
  const origExec = AnyDB.prototype.exec
  let failed = false
  AnyDB.prototype.exec = function (sql) {
    if (sql === 'BEGIN' && !failed) {
      failed = true
      throw new Error('synthetic non-full failure')
    }
    return origExec.call(this, sql)
  }

  const store = new SqliteCacheStore()
  t.teardown(() => {
    AnyDB.prototype.exec = origExec
    store.close()
  })

  store.set(makeKey({ path: '/hard-fail' }), makeValue())
  for (let i = 0; i < 4; i++) await flush()
  AnyDB.prototype.exec = origExec

  const flushWarnings = warnings.filter((w) => /synthetic non-full failure/.test(w.message))
  t.equal(flushWarnings.length, 1, 'exactly one warning, no retry loop')
  t.equal(store.get(makeKey({ path: '/hard-fail' })), undefined, 'batch dropped, nothing stored')

  // Store remains usable afterwards.
  store.set(makeKey({ path: '/recovered' }), makeValue())
  await flush()
  t.ok(store.get(makeKey({ path: '/recovered' })), 'store recovers after dropped batch')
  t.end()
})

test('flush stranded after a failing close(): deferred flush discards the remainder', async (t) => {
  const { StatementSync } = await import('node:sqlite')
  const AnyStmt = /** @type {any} */ (StatementSync)

  const dbPath = tmpDb(t, 'stranded-close')
  const store = new SqliteCacheStore({ location: dbPath })

  const warnings = collectWarnings(t)

  store.set(makeKey({ path: '/one' }), makeValue())
  store.set(makeKey({ path: '/poison' }), makeValue())
  store.set(makeKey({ path: '/three' }), makeValue())

  // Fail the second entry's write mid-transaction during close()'s final
  // flush: entries 1-2 are spliced off with the error, entry 3 stays queued
  // and a follow-up flush is scheduled — which then runs against the closed
  // store and must discard the remainder instead of touching the closed DB.
  const origRun = AnyStmt.prototype.run
  AnyStmt.prototype.run = function (...args) {
    if (args.some((a) => typeof a === 'string' && a.includes('/poison'))) {
      throw new Error('synthetic mid-batch failure')
    }
    return origRun.apply(this, args)
  }
  try {
    t.doesNotThrow(() => store.close(), 'close() swallows the flush error')
  } finally {
    AnyStmt.prototype.run = origRun
  }

  await flush() // deferred flush fires against the closed store
  await flush()

  t.ok(
    warnings.some((w) => /synthetic mid-batch failure/.test(w.message)),
    'flush failure surfaced as a warning',
  )
  t.equal(countRows(dbPath), 0, 'transaction rolled back; nothing persisted, nothing resurrected')
  t.end()
})

// ---------------------------------------------------------------------------
// findValue: fast path fall-through, batch merge, sort comparator
// ---------------------------------------------------------------------------

test('fast-path mismatch falls through to full scan and finds the older variant', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/scan', headers: { accept: 'text/html' } }),
    makeValue({ body: Buffer.from('html'), end: 4, vary: { accept: 'text/html' } }),
  )
  await flush()
  store.set(
    makeKey({ path: '/scan', headers: { accept: 'application/json' } }),
    makeValue({ body: Buffer.from('json'), end: 4, vary: { accept: 'application/json' } }),
  )
  await flush()

  // Newest row (json) mismatches → full scan sorts by id DESC and matches html.
  t.equal(
    store.get(makeKey({ path: '/scan', headers: { accept: 'text/html' } })).body.toString(),
    'html',
    'older variant found by the scan',
  )
  // No variant matches at all → scan returns undefined.
  t.equal(store.get(makeKey({ path: '/scan', headers: { accept: 'text/xml' } })), undefined)
  t.end()
})

test('pending batch entry beats an older flushed row for the same key', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/mixed-sort' }), makeValue({ body: Buffer.from('db___'), end: 5 }))
  await flush()
  store.set(makeKey({ path: '/mixed-sort' }), makeValue({ body: Buffer.from('batch'), end: 5 }))

  // values = [DB row, batch entry] → sort puts the batch entry first.
  t.equal(
    store.get(makeKey({ path: '/mixed-sort' })).body.toString(),
    'batch',
    'pending write wins over flushed row',
  )
  await flush()
  t.equal(store.get(makeKey({ path: '/mixed-sort' })).body.toString(), 'batch', 'and after flush')
  t.end()
})

test('two pending batch entries sort by seq (newest pending write wins)', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  // Different vary → not coalesced, both stay pending.
  store.set(
    makeKey({ path: '/seq', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ body: Buffer.from('gzip!'), end: 5, vary: { 'accept-encoding': 'gzip' } }),
  )
  store.set(
    makeKey({ path: '/seq', headers: { 'accept-encoding': 'br' } }),
    makeValue({ body: Buffer.from('brotl'), end: 5, vary: { 'accept-encoding': 'br' } }),
  )

  // Both pending entries land in values; the comparator orders them by seq
  // and matchesValue picks the right variant.
  t.equal(
    store.get(makeKey({ path: '/seq', headers: { 'accept-encoding': 'gzip' } })).body.toString(),
    'gzip!',
  )
  t.equal(
    store.get(makeKey({ path: '/seq', headers: { 'accept-encoding': 'br' } })).body.toString(),
    'brotl',
  )
  t.end()
})

test('sort interleaves two flushed rows and a pending entry correctly', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  // Two flushed vary variants + one pending third variant → values has three
  // candidates, so the comparator sees batch-vs-db pairs in both directions
  // and db-vs-db pairs.
  store.set(
    makeKey({ path: '/tri', headers: { accept: 'text/html' } }),
    makeValue({ body: Buffer.from('html_'), end: 5, vary: { accept: 'text/html' } }),
  )
  await flush()
  store.set(
    makeKey({ path: '/tri', headers: { accept: 'application/json' } }),
    makeValue({ body: Buffer.from('json_'), end: 5, vary: { accept: 'application/json' } }),
  )
  await flush()
  store.set(
    makeKey({ path: '/tri', headers: { accept: 'text/xml' } }),
    makeValue({ body: Buffer.from('xml__'), end: 5, vary: { accept: 'text/xml' } }),
  )

  t.equal(
    store.get(makeKey({ path: '/tri', headers: { accept: 'text/html' } })).body.toString(),
    'html_',
    'oldest flushed variant reachable past batch + newer row',
  )
  t.equal(
    store.get(makeKey({ path: '/tri', headers: { accept: 'application/json' } })).body.toString(),
    'json_',
  )
  t.equal(
    store.get(makeKey({ path: '/tri', headers: { accept: 'text/xml' } })).body.toString(),
    'xml__',
    'pending variant served from the batch',
  )
  t.end()
})

test('get() for a different URI while the batch is non-empty returns undefined', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/other' }), makeValue())
  t.equal(store.get(makeKey({ path: '/nothing-here' })), undefined)
  t.end()
})

test('expired or out-of-window pending entries are filtered by the batch merge', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const past = Date.now() - 120e3
  store.set(
    makeKey({ path: '/exp' }),
    makeValue({ deleteAt: past, staleAt: past, cachedAt: past - 2 }),
  )
  t.equal(store.get(makeKey({ path: '/exp' })), undefined, 'expired pending entry not served')

  store.set(
    makeKey({ path: '/win' }),
    makeValue({
      body: Buffer.from('part'),
      start: 10,
      end: 14,
      statusCode: 206,
      statusMessage: 'Partial Content',
    }),
  )
  t.equal(
    store.get(makeKey({ path: '/win' })),
    undefined,
    'start>0 pending entry not merged for plain GET',
  )
  t.end()
})

test('stored 206 with start=0 is not served to a request without Range', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/p0' }),
    makeValue({
      body: Buffer.from('01234'),
      start: 0,
      end: 5,
      statusCode: 206,
      statusMessage: 'Partial Content',
    }),
  )
  await flush()

  t.equal(store.get(makeKey({ path: '/p0' })), undefined, 'partial must not satisfy a full request')
  t.ok(
    store.get(makeKey({ path: '/p0', headers: { range: 'bytes=0-4' } })),
    'but the exact range still hits',
  )
  t.end()
})

test('range header edge shapes: array and unparsable strings miss', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/r' }), makeValue())
  await flush()

  t.equal(
    store.get(makeKey({ path: '/r', headers: { range: ['bytes=0-1', 'bytes=2-3'] } })),
    undefined,
  )
  t.equal(store.get(makeKey({ path: '/r', headers: { range: 'nonsense' } })), undefined)
  t.ok(store.get(makeKey({ path: '/r' })), 'plain get still hits')
  t.end()
})

// ---------------------------------------------------------------------------
// headerValueEquals via vary matching
// ---------------------------------------------------------------------------

test('vary: single-element array and bare scalar are equivalent', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  // Stored scalar, requested single-element array.
  store.set(
    makeKey({ path: '/hv1', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )
  // Stored single-element array, requested scalar.
  store.set(
    makeKey({ path: '/hv2', headers: { 'accept-encoding': ['br'] } }),
    makeValue({ vary: { 'accept-encoding': ['br'] } }),
  )
  await flush()

  t.ok(
    store.get(makeKey({ path: '/hv1', headers: { 'accept-encoding': ['gzip'] } })),
    "['gzip'] matches stored 'gzip'",
  )
  t.ok(
    store.get(makeKey({ path: '/hv2', headers: { 'accept-encoding': 'br' } })),
    "'br' matches stored ['br']",
  )
  t.end()
})

test('vary: multi-element array comparisons', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/hvarr', headers: { 'accept-encoding': ['gzip', 'br'] } }),
    makeValue({ vary: { 'accept-encoding': ['gzip', 'br'] } }),
  )
  await flush()

  t.ok(
    store.get(makeKey({ path: '/hvarr', headers: { 'accept-encoding': ['gzip', 'br'] } })),
    'identical arrays match',
  )
  t.equal(
    store.get(makeKey({ path: '/hvarr', headers: { 'accept-encoding': ['gzip', 'deflate'] } })),
    undefined,
    'same length, different content misses',
  )
  t.equal(
    store.get(makeKey({ path: '/hvarr', headers: { 'accept-encoding': ['gzip', 'br', 'x'] } })),
    undefined,
    'length mismatch misses',
  )
  t.equal(
    store.get(makeKey({ path: '/hvarr', headers: { 'accept-encoding': 'gzip' } })),
    undefined,
    'scalar vs multi-element array misses',
  )
  t.equal(
    store.get(makeKey({ path: '/hvarr' })),
    undefined,
    'request without the selecting header misses a non-null vary value',
  )
  t.end()
})

test('vary: null-valued selecting header matches absence, mismatches presence', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/hvnull' }), makeValue({ vary: { 'x-select': null } }))
  await flush()

  t.ok(store.get(makeKey({ path: '/hvnull' })), 'absent header matches stored null')
  t.equal(
    store.get(makeKey({ path: '/hvnull', headers: { 'x-select': 'set' } })),
    undefined,
    'present header mismatches stored null',
  )
  t.end()
})

// ---------------------------------------------------------------------------
// makeResult field mapping
// ---------------------------------------------------------------------------

test('batch read-through serves a COPY of the pending body (no aliasing)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = makeKey({ path: '/copy' })
  store.set(key, makeValue({ body: Buffer.from('hello') }))

  const served = store.get(key)
  t.equal(served.body.toString(), 'hello')
  served.body.fill(0x58) // mutate the served buffer before the flush

  await flush()
  t.equal(
    store.get(key).body.toString(),
    'hello',
    'flushed bytes unaffected by mutating the served body',
  )
  t.end()
})

test('makeResult maps every field for a fully populated DB row', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    makeKey({ path: '/fields', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({
      body: Buffer.from('body!'),
      end: 5,
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'text/plain', vary: 'accept-encoding' },
      etag: '"tag"',
      vary: { 'accept-encoding': 'gzip' },
      cacheControlDirectives: { 'max-age': 60, public: true },
      authorizationRequest: true,
      cachedAt: now,
      staleAt: now + 60e3,
      deleteAt: now + 120e3,
    }),
  )
  await flush()

  const r = store.get(makeKey({ path: '/fields', headers: { 'accept-encoding': 'gzip' } }))
  t.ok(Buffer.isBuffer(r.body), 'DB row body wrapped as Buffer')
  t.equal(r.body.toString(), 'body!')
  t.equal(r.statusCode, 200)
  t.equal(r.statusMessage, 'OK')
  t.strictSame(r.headers, { 'content-type': 'text/plain', vary: 'accept-encoding' })
  t.equal(r.etag, '"tag"')
  t.strictSame(r.vary, { 'accept-encoding': 'gzip' })
  t.strictSame(r.cacheControlDirectives, { 'max-age': 60, public: true })
  t.equal(r.authorizationRequest, true)
  t.equal(r.cachedAt, now)
  t.equal(r.staleAt, now + 60e3)
  t.equal(r.deleteAt, now + 120e3)
  t.end()
})

test('makeResult leaves optional fields undefined for a minimal row (null body)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/min' }),
    makeValue({ body: null, end: 0, statusCode: 204, statusMessage: 'No Content' }),
  )
  await flush()

  const r = store.get(makeKey({ path: '/min' }))
  t.equal(r.body, undefined)
  t.equal(r.headers, undefined)
  t.equal(r.etag, undefined)
  t.equal(r.vary, undefined)
  t.equal(r.cacheControlDirectives, undefined)
  t.equal(r.authorizationRequest, undefined)
  t.end()
})

test('set() without staleAt defaults it to deleteAt', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const value = makeValue({ cachedAt: now, deleteAt: now + 3600e3 })
  delete value.staleAt
  store.set(makeKey({ path: '/nostale' }), value)
  await flush()

  t.equal(store.get(makeKey({ path: '/nostale' })).staleAt, now + 3600e3)
  t.end()
})

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

test('assertCacheKey rejects bad keys with type-accurate messages', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(() => store.get(42), /expected key to be object, got number/)
  t.throws(() => store.get(null), /expected key to be object, got null/)
  // Object-typed property → printType reports the constructor name.
  t.throws(
    () => store.get({ origin: {}, method: 'GET', path: '/' }),
    /expected key\.origin to be string, got Object/,
  )
  t.throws(() => store.get({ origin: 'https://a', path: '/' }), /expected key\.method to be string/)
  t.throws(
    () => store.get({ origin: 'https://a', method: 'GET' }),
    /expected key\.path to be string/,
  )
  t.throws(() => store.get(makeKey({ headers: 7 })), /expected headers to be object, got number/)
  t.end()
})

test('assertCacheValue rejects bad values (including staleAt type)', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(() => store.set(makeKey(), null), /expected value to be object, got null/)
  t.throws(() => store.set(makeKey(), 'x'), /expected value to be object, got string/)
  for (const field of ['statusCode', 'cachedAt', 'deleteAt']) {
    t.throws(
      () => store.set(makeKey(), makeValue({ [field]: 'nan' })),
      new RegExp(`expected value\\.${field} to be number, got string`),
    )
  }
  t.throws(
    () => store.set(makeKey(), makeValue({ staleAt: 'soon' })),
    /expected value\.staleAt to be number, got string/,
    'supplied non-number staleAt is rejected',
  )
  t.throws(
    () => store.set(makeKey(), makeValue({ statusMessage: 9 })),
    /expected value\.statusMessage to be string/,
  )
  t.throws(
    () => store.set(makeKey(), makeValue({ headers: 'h' })),
    /expected value\.rawHeaders to be object/,
  )
  t.throws(
    () => store.set(makeKey(), makeValue({ vary: 'v' })),
    /expected value\.vary to be object/,
  )
  t.throws(() => store.set(makeKey(), makeValue({ etag: 5 })), /expected value\.etag to be string/)
  t.end()
})

test('set() start/end validation: TypeError vs RangeError', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(
    () => store.set(makeKey(), makeValue({ start: '0' })),
    TypeError,
    'non-number start → TypeError',
  )
  t.throws(
    () => store.set(makeKey(), makeValue({ start: -1 })),
    RangeError,
    'negative start → RangeError',
  )
  t.throws(
    () => store.set(makeKey(), makeValue({ start: Infinity })),
    RangeError,
    'non-finite start → RangeError',
  )
  t.throws(
    () => store.set(makeKey(), makeValue({ end: '5', body: null })),
    TypeError,
    'non-number end → TypeError',
  )
  t.throws(
    () => store.set(makeKey(), makeValue({ start: 10, end: 5, body: null })),
    RangeError,
    'end < start → RangeError',
  )
  t.throws(
    () => store.set(makeKey(), makeValue({ end: NaN, body: null })),
    RangeError,
    'NaN end → RangeError',
  )
  t.throws(
    () => store.set(makeKey(), makeValue({ body: Buffer.from('hello'), end: 9 })),
    RangeError,
    'body length mismatch → RangeError',
  )
  // Array body is concatenated before the length check.
  t.doesNotThrow(() =>
    store.set(
      makeKey({ path: '/arr' }),
      makeValue({ body: [Buffer.from('he'), Buffer.from('llo')], end: 5 }),
    ),
  )
  t.end()
})

// ---------------------------------------------------------------------------
// Registry pruning of GC-collected stores (best-effort, but the assertions
// are deterministic: every broadcast must reach the live store).
// ---------------------------------------------------------------------------

test('broadcast dispatch survives (and prunes) WeakRefs of collected stores', async (t) => {
  v8.setFlagsFromString('--expose-gc')
  const gcFn = vm.runInNewContext('gc')
  v8.setFlagsFromString('--no-expose-gc')

  // The FinalizationRegistry prunes dead refs between tasks, so a GC that
  // completes before the broadcast is delivered leaves nothing to observe.
  // Instead trigger the GC synchronously from INSIDE the dispatch loop (the
  // first registered store's gc()), the way a natural allocation-triggered GC
  // can interleave in production: the loop then reaches the churned stores'
  // WeakRefs after they died but before the registry's cleanup task can run,
  // and must prune them without throwing.
  // Unclosed stores registered after `live` are held strongly until the
  // dispatch reaches live.gc(), so no earlier (natural) GC can collect them
  // and let the FinalizationRegistry prune their refs ahead of time.
  const churned = []

  const live = new SqliteCacheStore()
  t.teardown(() => live.close())
  let dispatched = 0
  live.gc = () => {
    dispatched++
    churned.length = 0 // drop the only strong refs mid-dispatch
    try {
      gcFn()
      gcFn()
    } catch {}
  }

  for (let i = 0; i < 8; i++) {
    churned.push(new SqliteCacheStore())
  }
  await flush()

  const bc = new BroadcastChannel('nxt:offPeak')
  t.teardown(() => bc.close())
  bc.postMessage(null)
  t.ok(await waitFor(() => dispatched > 0), 'dispatch reached the live store and did not throw')

  // The registry stays consistent: a second broadcast still reaches the live
  // store after the dead refs were pruned mid-dispatch.
  bc.postMessage(null)
  t.ok(await waitFor(() => dispatched > 1), 'second broadcast delivered after pruning')
  t.end()
})

test('get() sorts a pending batch entry ahead of an already-flushed row (comparator mixed-source arm)', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const key = makeKey({ path: '/mixed-sources' })

  // First write lands in the DB…
  store.set(key, makeValue({ body: Buffer.from('old!!'), start: 0, end: 5 }))
  await flush()
  // …second write stays in the pending batch at read time. Same key, same
  // vary (none): the candidate set holds one flushed row and one batch entry,
  // which drives the aBatch !== bBatch comparator arm, and the batch entry
  // (newer by definition) must win.
  store.set(key, makeValue({ body: Buffer.from('new!!'), start: 0, end: 5 }))
  const result = store.get(key)
  t.ok(result, 'entry found')
  t.equal(result.body.toString(), 'new!!', 'pending batch write wins over the flushed row')
  t.end()
})
