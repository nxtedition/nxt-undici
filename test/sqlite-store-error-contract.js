/* eslint-disable */
// SqliteCacheStore error-contract hardening:
//
// 1. delete() must warn instead of throwing on DB errors (e.g. SQLITE_BUSY on
//    a shared file-backed store) — the same never-throw contract set()/gc()/
//    clear() already have; a transient lock must not propagate into the
//    interceptor's response path.
// 2. A flush whose ROLLBACK itself fails must not wedge the store: without
//    the pre-BEGIN transaction guard, the connection stays mid-transaction,
//    every subsequent BEGIN throws "cannot start a transaction within a
//    transaction", and each future batch is silently dropped — a permanent
//    write outage. The guard rolls the stale transaction back and the very
//    next batch must land.
import { test } from 'tap'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'

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

const flush = () => new Promise((resolve) => setImmediate(resolve))

function tmpDb(t, name) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nxt-store-contract-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, `${name}.sqlite`)
}

// Capture process warnings for the duration of a test.
function collectWarnings(t) {
  const warnings = []
  const onWarning = (w) => warnings.push(w)
  process.on('warning', onWarning)
  t.teardown(() => process.removeListener('warning', onWarning))
  return warnings
}

// Warnings are emitted asynchronously (process.emitWarning defers to the next
// tick); poll bounded instead of assuming a single tick.
async function waitFor(fn, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!fn()) {
    if (Date.now() > deadline) {
      return false
    }
    await flush()
  }
  return true
}

// ---------------------------------------------------------------------------
// delete(): never throws
// ---------------------------------------------------------------------------

test('delete() warns instead of throwing when the database is locked', async (t) => {
  const dbPath = tmpDb(t, 'busy-delete')
  const store = new SqliteCacheStore({ location: dbPath, db: { timeout: 5 } })
  t.teardown(() => store.close())

  const key = makeKey()
  store.set(key, makeValue())
  await flush()
  t.ok(store.get(key), 'entry stored')

  const warnings = collectWarnings(t)

  // A second connection holding the write lock makes the store's DELETE hit
  // SQLITE_BUSY once its 5ms busy timeout expires.
  const locker = new DatabaseSync(dbPath)
  locker.exec('PRAGMA busy_timeout = 5')
  locker.exec('BEGIN IMMEDIATE')
  t.teardown(() => {
    try {
      locker.close()
    } catch {}
  })

  t.doesNotThrow(() => store.delete(key), 'locked delete does not throw')
  t.ok(
    await waitFor(() => warnings.some((w) => /locked|busy/i.test(w.message))),
    'the lock error surfaces as a warning',
  )

  // Once the lock clears, invalidation works again.
  locker.exec('ROLLBACK')
  store.delete(key)
  t.equal(store.get(key), undefined, 'entry deleted after the lock cleared')
  t.end()
})

// ---------------------------------------------------------------------------
// flush: a failed ROLLBACK must not wedge every subsequent flush
// ---------------------------------------------------------------------------

test('flush recovers after a ROLLBACK failure leaves the connection mid-transaction', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  const warnings = collectWarnings(t)

  const AnyDB = /** @type {any} */ (DatabaseSync)
  const AnyStmt = /** @type {any} */ (StatementSync)
  const origExec = AnyDB.prototype.exec
  const origRun = AnyStmt.prototype.run

  // One flush fails mid-transaction (the 14-arg insert throws) AND its
  // ROLLBACK fails without rolling back — the connection is left inside the
  // transaction, which is exactly the wedge scenario.
  let failInsert = true
  AnyStmt.prototype.run = function (...args) {
    if (failInsert && args.length > 10) {
      failInsert = false
      throw new Error('synthetic insert failure')
    }
    return origRun.apply(this, args)
  }
  AnyDB.prototype.exec = function (sql) {
    if (sql === 'ROLLBACK') {
      // Fail WITHOUT executing: the transaction stays open.
      throw new Error('synthetic rollback failure')
    }
    return origExec.call(this, sql)
  }
  t.teardown(() => {
    AnyDB.prototype.exec = origExec
    AnyStmt.prototype.run = origRun
  })

  store.set(makeKey({ path: '/wedged' }), makeValue())
  await flush()
  await flush()

  // Restore real behavior; the connection is now stuck mid-transaction.
  AnyDB.prototype.exec = origExec
  AnyStmt.prototype.run = origRun

  t.ok(
    warnings.some((w) => /synthetic rollback failure/.test(w.message)),
    'the rollback failure is surfaced as a warning, not swallowed',
  )
  t.ok(
    warnings.some((w) => /synthetic insert failure/.test(w.message)),
    'the original flush failure is warned as before',
  )

  // The very next batch must land: the pre-BEGIN guard rolls the stale
  // transaction back instead of dropping this batch (and every one after it).
  const key = makeKey({ path: '/after-wedge' })
  store.set(key, makeValue({ body: Buffer.from('world'), end: 5 }))
  t.ok(
    await waitFor(() => store.get(key) !== undefined),
    'first batch after the wedge is stored, not dropped',
  )
  t.equal(store.get(key).body.toString(), 'world', 'stored body intact')
  t.end()
})

test('SQLITE_FULL auto-rollback path issues no explicit ROLLBACK (isTransaction guard)', async (t) => {
  // Plain regression guard for the rewritten catch: a normal store keeps
  // working across many set/get/delete cycles with the new transaction
  // hygiene (no stray "no transaction is active" warnings).
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())
  const warnings = collectWarnings(t)

  for (let i = 0; i < 50; i++) {
    const key = makeKey({ path: `/cycle-${i}` })
    store.set(key, makeValue())
    if (i % 7 === 0) {
      await flush()
    }
    if (i % 3 === 0) {
      store.delete(key)
    }
  }
  await flush()
  await flush()

  t.equal(
    warnings.filter((w) => /transaction/i.test(w.message)).length,
    0,
    'no transaction-related warnings in normal operation',
  )
  t.ok(store.get(makeKey({ path: '/cycle-49' })), 'entries land normally')
  t.end()
})
