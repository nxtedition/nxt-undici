// Regression tests for the 2026-07 cache deep-review fixes (sqlite store):
// - #flush must not busy-loop on setImmediate when the SQLITE_FULL eviction
//   query itself throws (batch pinned forever, CPU pegged, warning spam).
// - schema v12: the lookup query must not need a temp B-tree sort (which
//   materialized every candidate row's body blob per get), and the body blob
//   must be the last column so candidate filtering never walks its overflow
//   pages.
// - the constructor must survive SQLITE_BUSY from another process's write
//   transaction during a multi-process cold start on a shared DB file.
// - max_page_count must derive from the file's actual page size, not a
//   hard-coded 4096 (4x premature SQLITE_FULL on a 1024-byte-page file).
// - close() must be idempotent.
// - maxEntrySize/maxEntryTTL constructor options must be honored via getters
//   (CacheHandler reads store.maxEntrySize ?? default).
// - vary selector maps must serialize canonically so the text-comparing
//   supersede/coalesce logic replaces equivalent variants instead of
//   accumulating dead duplicate rows.
import { test } from 'tap'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

test('#flush drops the batch instead of spinning when the FULL-eviction query throws', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  const origRun = StatementSync.prototype.run
  t.teardown(() => {
    StatementSync.prototype.run = origRun
  })
  StatementSync.prototype.run = function (...args) {
    const sql = this.sourceSQL ?? ''
    if (/^\s*INSERT INTO cacheInterceptorV/.test(sql)) {
      const err = new Error('database or disk is full')
      err.errcode = 13 // SQLITE_FULL
      throw err
    }
    if (/ORDER BY deleteAt ASC LIMIT/.test(sql)) {
      const err = new Error('database is locked')
      err.errcode = 5 // SQLITE_BUSY
      throw err
    }
    return origRun.apply(this, args)
  }

  let warnings = 0
  const onWarning = () => {
    warnings++
  }
  process.on('warning', onWarning)
  t.teardown(() => process.removeListener('warning', onWarning))

  store.set(makeKey(), makeValue())
  // Pre-fix this window accumulates thousands of flush iterations (one
  // warning each); post-fix the batch is dropped on the first evict failure.
  await sleep(250)
  await flush()

  t.ok(warnings < 10, `bounded warnings, got ${warnings}`)

  // The store must not be wedged: with the fault removed, writes work again.
  StatementSync.prototype.run = origRun
  store.set(makeKey({ path: '/after' }), makeValue())
  await flush()
  t.equal(store.get(makeKey({ path: '/after' }))?.body?.toString(), 'hello')
  t.end()
})

test('schema v12: no temp B-tree sort on lookup; body blob is the last column', async (t) => {
  const dbPath = tmpDb(t, 'v12-plan')
  const store = new SqliteCacheStore({ location: dbPath })
  store.set(makeKey(), makeValue())
  await flush()
  t.ok(store.get(makeKey()), 'sanity: entry readable')
  store.close()

  const db = new DatabaseSync(dbPath, { readOnly: true })
  t.teardown(() => db.close())
  const table = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cacheInterceptorV%'`,
    )
    .all()
    .map((r) => r.name)
    .find((n) => /^cacheInterceptorV\d+$/.test(n))
  t.ok(table, 'store table exists')

  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  t.equal(cols[cols.length - 1].name, 'body', 'body is the last column')

  // Mirror of #getValuesQuery's shape: same WHERE and ORDER BY. The (url,
  // method) index must satisfy ORDER BY id DESC via a backward scan — no
  // temp B-tree, which would materialize every candidate row (incl. blobs).
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT id, start, end, deleteAt FROM ${table}
       WHERE url = ? AND method = ? AND start <= ? AND deleteAt > ? ORDER BY id DESC`,
    )
    .all()
  t.notOk(
    plan.some((r) => /TEMP B-TREE/i.test(r.detail)),
    `no temp b-tree in plan: ${plan.map((r) => r.detail).join(' | ')}`,
  )
  t.end()
})

test('constructor retries SQLITE_BUSY while another process holds the write lock', async (t) => {
  const dbPath = tmpDb(t, 'busy-cold-start')

  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(process.argv[1])
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('BEGIN IMMEDIATE')
      db.exec('CREATE TABLE IF NOT EXISTS holder (x INTEGER)')
      db.exec('INSERT INTO holder VALUES (1)')
      console.log('locked')
      setTimeout(() => {
        db.exec('COMMIT')
        db.close()
      }, 500)
      `,
      dbPath,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  t.teardown(() => child.kill('SIGKILL'))

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never locked')), 10e3)
    child.stdout.on('data', (d) => {
      if (`${d}`.includes('locked')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', () => reject(new Error('child exited early')))
  })

  // Pre-fix: throws SQLITE_BUSY ('database is locked') after the 20ms busy
  // timeout. Post-fix: bounded retry outlasts the child's 500ms hold.
  const store = new SqliteCacheStore({ location: dbPath })
  t.teardown(() => store.close())
  store.set(makeKey(), makeValue())
  await flush()
  t.equal(store.get(makeKey())?.body?.toString(), 'hello', 'store constructed and usable')
  t.end()
})

test('max_page_count uses the actual page size of a pre-existing DB file', async (t) => {
  const dbPath = tmpDb(t, 'page-size')

  // Pin a 1024-byte page size before the store ever sees the file. With the
  // hard-coded 4096 the byte cap becomes maxSize/4 and eviction churns at a
  // quarter of the configured budget.
  const seed = new DatabaseSync(dbPath)
  seed.exec(`
    PRAGMA page_size = 1024;
    CREATE TABLE seed (x INTEGER);
  `)
  seed.close()

  const store = new SqliteCacheStore({ location: dbPath, maxSize: 1024 * 1024 })
  t.teardown(() => store.close())

  const chunk = Buffer.alloc(16 * 1024, 0x61)
  for (let i = 0; i < 40; i++) {
    store.set(makeKey({ path: `/blob/${i}` }), makeValue({ body: chunk, end: chunk.length }))
    await flush()
  }

  let present = 0
  for (let i = 0; i < 40; i++) {
    if (store.get(makeKey({ path: `/blob/${i}` }))) present++
  }
  // 40 x 16KB = 640KB of bodies fits comfortably in a real 1MB cap; under the
  // pre-fix 256KB effective cap SQLITE_FULL evictions delete most rows.
  t.equal(present, 40, `all entries retained under the configured cap (got ${present})`)
  t.end()
})

test('close() is idempotent', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  store.close()
  t.doesNotThrow(() => store.close(), 'second close is a no-op')
  t.end()
})

test('maxEntrySize / maxEntryTTL constructor options are exposed as getters', async (t) => {
  const store = new SqliteCacheStore({
    location: ':memory:',
    maxEntrySize: 10 * 1024 * 1024,
    maxEntryTTL: 123,
  })
  t.teardown(() => store.close())
  t.equal(store.maxEntrySize, 10 * 1024 * 1024)
  t.equal(store.maxEntryTTL, 123)

  const bare = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => bare.close())
  t.equal(
    bare.maxEntrySize,
    undefined,
    'unset option resolves undefined (CacheHandler default applies)',
  )
  t.end()
})

test('equivalent vary maps serialize canonically so supersede replaces instead of duplicating', async (t) => {
  const dbPath = tmpDb(t, 'vary-canon')
  const store = new SqliteCacheStore({ location: dbPath })
  t.teardown(() => store.close())

  store.set(makeKey(), makeValue({ vary: { b: 'y', 'accept-encoding': ['gzip'] } }))
  await flush()
  // Same logical variant: different key order, scalar instead of one-element
  // array (headerValueEquals treats these as equal).
  store.set(makeKey(), makeValue({ vary: { 'accept-encoding': 'gzip', b: 'y' } }))
  await flush()

  const db = new DatabaseSync(dbPath, { readOnly: true })
  t.teardown(() => db.close())
  const table = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cacheInterceptorV%'`,
    )
    .all()
    .map((r) => r.name)
    .find((n) => /^cacheInterceptorV\d+$/.test(n))
  const rows = db.prepare(`SELECT vary FROM ${table} WHERE url = ?`).all('https://example.com/test')
  t.equal(rows.length, 1, 'second write superseded the first')
  t.equal(rows[0].vary, '{"accept-encoding":"gzip","b":"y"}', 'canonical serialization')
  t.end()
})
