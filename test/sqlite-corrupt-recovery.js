// Regression tests for issue #70: a file-backed SqliteCacheStore runs WAL with
// `synchronous = OFF`, which per SQLite permits corruption on OS crash/power
// loss. Construction must recover from a corrupt file by discarding it and
// rebuilding, instead of throwing forever until a human deletes the file.
import { test } from 'tap'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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

function tmpDb(t, prefix) {
  const dbPath = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
  )
  t.teardown(() => {
    for (const ext of ['', '-wal', '-shm', '-journal']) {
      try {
        fs.unlinkSync(dbPath + ext)
      } catch {}
    }
  })
  return dbPath
}

// Collect process warnings for the duration of `fn`, then return them.
async function withWarnings(fn) {
  const warnings = []
  const onWarning = (w) => warnings.push(w)
  process.on('warning', onWarning)
  try {
    const result = await fn()
    // emitWarning is delivered asynchronously; let it land.
    await flush()
    return { result, warnings }
  } finally {
    process.removeListener('warning', onWarning)
  }
}

test('recovers from a file that is not a SQLite database (SQLITE_NOTADB)', async (t) => {
  const dbPath = tmpDb(t, 'corrupt-notadb')

  // Garbage bytes: no valid SQLite header magic, so the first access throws
  // SQLITE_NOTADB (errcode 26).
  fs.writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file'))

  const { result: store, warnings } = await withWarnings(
    async () => new SqliteCacheStore({ location: dbPath }),
  )
  t.teardown(() => store.close())

  t.ok(
    warnings.some((w) => /corrupt database/i.test(String(w?.message ?? w))),
    'emitted a corruption warning',
  )

  // The rebuilt store is fully functional.
  store.set(makeKey({ path: '/fresh' }), makeValue({ body: Buffer.from('fresh'), end: 5 }))
  await flush()
  const got = store.get(makeKey({ path: '/fresh' }))
  t.ok(got, 'store works after recovery')
  t.equal(got.body.toString(), 'fresh')

  // The file on disk is now a real SQLite database.
  const check = new DatabaseSync(dbPath, { readOnly: true })
  t.teardown(() => check.close())
  const tables = check
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((r) => r.name)
  t.ok(
    tables.some((name) => /^cacheInterceptorV\d+$/.test(name)),
    'current version table recreated on disk',
  )
  t.end()
})

test('recovers from a truncated/corrupt SQLite header', async (t) => {
  const dbPath = tmpDb(t, 'corrupt-truncated')

  // Start from a real SQLite file so it carries the header magic, then corrupt
  // the header page in place.
  const seed = new DatabaseSync(dbPath)
  seed.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);')
  seed.close()

  const fd = fs.openSync(dbPath, 'r+')
  // Overwrite the page-size / header fields region with garbage.
  fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, 16)
  fs.closeSync(fd)

  const { result: store } = await withWarnings(
    async () => new SqliteCacheStore({ location: dbPath }),
  )
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/a' }), makeValue({ body: Buffer.from('world'), end: 5 }))
  await flush()
  const got = store.get(makeKey({ path: '/a' }))
  t.ok(got, 'store works after recovery from corrupt header')
  t.equal(got.body.toString(), 'world')
  t.end()
})

test(':memory: store construction is unaffected', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())
  store.set(makeKey(), makeValue())
  await flush()
  t.ok(store.get(makeKey()), 'in-memory store works')
  t.end()
})
