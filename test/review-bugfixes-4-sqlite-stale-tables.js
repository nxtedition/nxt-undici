/* eslint-disable */
// Regression tests: stale cacheInterceptorV{N} tables from older schema
// versions must be dropped on startup. gc()/clear()/eviction only touch the
// current version's table, so without the cleanup a VERSION bump on a
// max_page_count-capped file leaves the old table's pages allocated forever
// and new inserts starve with SQLITE_FULL.
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
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + ext)
      } catch {}
    }
  })
  return dbPath
}

test('old-version cacheInterceptorV{N} tables are dropped on startup', async (t) => {
  const dbPath = tmpDb(t, 'stale-tables')

  // Seed the file with tables from two older schema versions, each with rows
  // and an index — as left behind by a real VERSION bump.
  const seed = new DatabaseSync(dbPath)
  seed.exec(`
    CREATE TABLE cacheInterceptorV8 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      body BLOB NULL
    );
    CREATE INDEX idx_cacheInterceptorV8_url ON cacheInterceptorV8(url);
    INSERT INTO cacheInterceptorV8 (url, body) VALUES ('https://old.example.com/a', x'deadbeef');
    CREATE TABLE cacheInterceptorV9 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      body BLOB NULL
    );
    CREATE INDEX idx_cacheInterceptorV9_url ON cacheInterceptorV9(url);
    INSERT INTO cacheInterceptorV9 (url, body) VALUES ('https://old.example.com/b', x'deadbeef');
  `)
  seed.close()

  const store = new SqliteCacheStore({ location: dbPath })

  // The current version's table must be fully functional.
  store.set(makeKey({ path: '/fresh' }), makeValue({ body: Buffer.from('fresh'), end: 5 }))
  await flush()
  const result = store.get(makeKey({ path: '/fresh' }))
  t.ok(result, 'current table works after cleanup')
  t.equal(result.body.toString(), 'fresh')
  store.close()

  const check = new DatabaseSync(dbPath, { readOnly: true })
  t.teardown(() => check.close())
  const tables = check
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => row.name)
  t.notOk(tables.includes('cacheInterceptorV8'), 'V8 table dropped')
  t.notOk(tables.includes('cacheInterceptorV9'), 'V9 table dropped')
  t.ok(
    tables.some((name) => /^cacheInterceptorV\d+$/.test(name)),
    'current version table exists',
  )
  const staleIndexes = check
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_cacheInterceptorV8%' OR name LIKE 'idx_cacheInterceptorV9%')`,
    )
    .all()
  t.equal(staleIndexes.length, 0, 'stale indexes dropped along with their tables')
  t.end()
})

test('unrelated user tables in the same file are not dropped', async (t) => {
  const dbPath = tmpDb(t, 'stale-tables-user')

  const seed = new DatabaseSync(dbPath)
  seed.exec(`
    CREATE TABLE cacheInterceptorV9 (id INTEGER PRIMARY KEY, url TEXT);
    INSERT INTO cacheInterceptorV9 (url) VALUES ('https://old.example.com/');
    CREATE TABLE userData (k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO userData (k, v) VALUES ('keep', 'me');
  `)
  seed.close()

  const store = new SqliteCacheStore({ location: dbPath })
  store.close()

  const check = new DatabaseSync(dbPath, { readOnly: true })
  t.teardown(() => check.close())
  const tables = check
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => row.name)
  t.notOk(tables.includes('cacheInterceptorV9'), 'stale cache table dropped')
  t.ok(tables.includes('userData'), 'user table preserved')
  const row = check.prepare('SELECT v FROM userData WHERE k = ?').get('keep')
  t.equal(row.v, 'me', 'user table rows intact')
  t.end()
})
