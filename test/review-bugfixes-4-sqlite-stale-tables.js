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

  // Seed the file with tables from two other schema versions, each with rows
  // and an index — as left behind by a real VERSION bump. Version numbers are
  // huge so they can never collide with the store's current VERSION, plus a
  // non-digit-suffix table that only shares the prefix and must survive.
  const seed = new DatabaseSync(dbPath)
  seed.exec(`
    CREATE TABLE cacheInterceptorV99998 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      body BLOB NULL
    );
    CREATE INDEX idx_cacheInterceptorV99998_url ON cacheInterceptorV99998(url);
    INSERT INTO cacheInterceptorV99998 (url, body) VALUES ('https://old.example.com/a', x'deadbeef');
    CREATE TABLE cacheInterceptorV99999 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      body BLOB NULL
    );
    CREATE INDEX idx_cacheInterceptorV99999_url ON cacheInterceptorV99999(url);
    INSERT INTO cacheInterceptorV99999 (url, body) VALUES ('https://old.example.com/b', x'deadbeef');
    CREATE TABLE cacheInterceptorVBackup (k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO cacheInterceptorVBackup (k, v) VALUES ('keep', 'me');
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
  t.notOk(tables.includes('cacheInterceptorV99998'), 'V99998 table dropped')
  t.notOk(tables.includes('cacheInterceptorV99999'), 'V99999 table dropped')
  t.ok(tables.includes('cacheInterceptorVBackup'), 'non-digit-suffix table preserved')
  t.equal(
    check.prepare('SELECT v FROM cacheInterceptorVBackup WHERE k = ?').get('keep').v,
    'me',
    'non-digit-suffix table rows intact',
  )
  t.ok(
    tables.some((name) => /^cacheInterceptorV\d+$/.test(name)),
    'current version table exists',
  )
  const staleIndexes = check
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_cacheInterceptorV99998%' OR name LIKE 'idx_cacheInterceptorV99999%')`,
    )
    .all()
  t.equal(staleIndexes.length, 0, 'stale indexes dropped along with their tables')
  t.end()
})

test('unrelated user tables in the same file are not dropped', async (t) => {
  const dbPath = tmpDb(t, 'stale-tables-user')

  const seed = new DatabaseSync(dbPath)
  seed.exec(`
    CREATE TABLE cacheInterceptorV99999 (id INTEGER PRIMARY KEY, url TEXT);
    INSERT INTO cacheInterceptorV99999 (url) VALUES ('https://old.example.com/');
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
  t.notOk(tables.includes('cacheInterceptorV99999'), 'stale cache table dropped')
  t.ok(tables.includes('userData'), 'user table preserved')
  const row = check.prepare('SELECT v FROM userData WHERE k = ?').get('keep')
  t.equal(row.v, 'me', 'user table rows intact')
  t.end()
})
