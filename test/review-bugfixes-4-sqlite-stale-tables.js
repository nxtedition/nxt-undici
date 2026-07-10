// SQLite cache files are intentionally never migrated or destructively
// repaired. A different cache schema version or corrupt database is an
// operator-visible startup failure, and the file must remain untouched.
import { test } from 'tap'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'

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

function tableNames(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map(({ name }) => name)
}

test('incompatible cache schema versions fail without modifying the database', (t) => {
  const dbPath = tmpDb(t, 'schema-mismatch')
  const seed = new DatabaseSync(dbPath)
  seed.exec(`
    CREATE TABLE cacheInterceptorV99998 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      body BLOB
    );
    INSERT INTO cacheInterceptorV99998 (url, body)
      VALUES ('https://old.example.com/a', x'deadbeef');
    CREATE TABLE cacheInterceptorV99999 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      body BLOB
    );
    INSERT INTO cacheInterceptorV99999 (url, body)
      VALUES ('https://old.example.com/b', x'cafebabe');
    CREATE TABLE userData (k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO userData (k, v) VALUES ('keep', 'me');
  `)
  seed.close()

  let error
  try {
    new SqliteCacheStore({ location: dbPath })
    t.fail('construction should reject an incompatible cache schema')
  } catch (err) {
    error = err
  }
  t.equal(error?.name, 'SqliteCacheSchemaError')
  t.equal(error?.code, 'ERR_SQLITE_CACHE_SCHEMA_MISMATCH')
  t.match(error?.message, /cacheInterceptorV99998, cacheInterceptorV99999/)

  const check = new DatabaseSync(dbPath, { readOnly: true })
  t.teardown(() => check.close())
  const numericCacheTables = tableNames(check).filter((name) => /^cacheInterceptorV\d+$/.test(name))
  t.strictSame(
    numericCacheTables,
    ['cacheInterceptorV99998', 'cacheInterceptorV99999'],
    'no current table was created and no incompatible table was dropped',
  )
  t.equal(
    check.prepare('SELECT v FROM userData WHERE k = ?').get('keep').v,
    'me',
    'unrelated application data is unchanged',
  )
  t.equal(
    check.prepare('SELECT hex(body) AS body FROM cacheInterceptorV99999').get().body,
    'CAFEBABE',
    'incompatible cache data is unchanged',
  )
  t.end()
})

test('non-version tables sharing the cache prefix remain compatible', (t) => {
  const dbPath = tmpDb(t, 'prefix-table')
  const seed = new DatabaseSync(dbPath)
  seed.exec(`
    CREATE TABLE cacheInterceptorVBackup (k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO cacheInterceptorVBackup (k, v) VALUES ('keep', 'me');
  `)
  seed.close()

  const store = new SqliteCacheStore({ location: dbPath })
  store.close()

  const check = new DatabaseSync(dbPath, { readOnly: true })
  t.teardown(() => check.close())
  t.equal(
    check.prepare('SELECT v FROM cacheInterceptorVBackup WHERE k = ?').get('keep').v,
    'me',
    'prefix-sharing user table remains intact',
  )
  t.ok(
    tableNames(check).some((name) => /^cacheInterceptorV\d+$/.test(name)),
    'the current cache table was created',
  )
  t.end()
})

test('corrupt database fails hard and is not replaced', (t) => {
  const dbPath = tmpDb(t, 'corrupt-db')
  const original = Buffer.from('this is not a sqlite database')
  fs.writeFileSync(dbPath, original)

  let error
  try {
    new SqliteCacheStore({ location: dbPath })
    t.fail('construction should reject a corrupt database')
  } catch (err) {
    error = err
  }
  t.equal(error?.errcode, 26, 'original SQLITE_NOTADB error propagates')
  t.strictSame(fs.readFileSync(dbPath), original, 'corrupt file is preserved byte-for-byte')
  t.end()
})

test('a close() failure during schema-error cleanup does not mask the original error', (t) => {
  const dbPath = tmpDb(t, 'schema-close-fail')
  const seed = new DatabaseSync(dbPath)
  seed.exec('CREATE TABLE cacheInterceptorV99999 (id INTEGER PRIMARY KEY);')
  seed.close()

  // Force close() to throw only while the constructor is cleaning up after the
  // schema check fails, so both errors race to propagate out of the catch.
  const realClose = DatabaseSync.prototype.close
  const closeErr = new Error('close boom')
  DatabaseSync.prototype.close = function () {
    throw closeErr
  }

  let error
  try {
    new SqliteCacheStore({ location: dbPath })
    t.fail('construction should reject an incompatible cache schema')
  } catch (err) {
    error = err
  } finally {
    DatabaseSync.prototype.close = realClose
  }

  t.equal(error?.name, 'SuppressedError', 'both failures are retained in a SuppressedError')
  t.equal(error?.error?.name, 'SqliteCacheSchemaError', 'the schema error stays the primary .error')
  t.equal(error?.suppressed, closeErr, 'the close() failure is retained as .suppressed')
  t.end()
})
