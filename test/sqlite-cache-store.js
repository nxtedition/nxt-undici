/* eslint-disable */
import { test } from 'tap'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'

test('basic get/set round-trip', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/test' }
  const now = Date.now()
  const value = {
    body: Buffer.from('hello world'),
    start: 0,
    end: 11,
    statusCode: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'text/plain' },
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(key, value)

  const result = store.get(key)
  t.ok(result)
  t.equal(result.statusCode, 200)
  t.equal(result.statusMessage, 'OK')
  t.strictSame(result.headers, { 'content-type': 'text/plain' })
  t.equal(result.body.toString(), 'hello world')
  t.end()
})

test('get returns undefined for missing key', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/missing' }
  t.equal(store.get(key), undefined)
  t.end()
})

test('get returns undefined for expired entry', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/expired' }
  const past = Date.now() - 10000
  const value = {
    body: Buffer.from('expired'),
    start: 0,
    end: 7,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: past - 20000,
    staleAt: past - 10000,
    deleteAt: past,
  }

  store.set(key, value)
  t.equal(store.get(key), undefined)
  t.end()
})

test('vary header matching', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const key = {
    origin: 'https://example.com',
    method: 'GET',
    path: '/vary',
    headers: { 'accept-encoding': 'gzip' },
  }
  const value = {
    body: Buffer.from('gzipped'),
    start: 0,
    end: 7,
    statusCode: 200,
    statusMessage: 'OK',
    vary: { 'accept-encoding': 'gzip' },
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(key, value)

  // Same vary header - should match
  const result = store.get(key)
  t.ok(result)
  t.equal(result.body.toString(), 'gzipped')

  // Different vary header - should not match
  const key2 = {
    origin: 'https://example.com',
    method: 'GET',
    path: '/vary',
    headers: { 'accept-encoding': 'br' },
  }
  const result2 = store.get(key2)
  t.equal(result2, undefined)
  t.end()
})

test('set with array body', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/array-body' }
  const now = Date.now()
  const value = {
    body: [Buffer.from('hello'), Buffer.from(' world')],
    start: 0,
    end: 11,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(key, value)
  const result = store.get(key)
  t.ok(result)
  t.equal(result.body.toString(), 'hello world')
  t.end()
})

test('set with null body', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/null-body' }
  const now = Date.now()
  const value = {
    body: null,
    start: 0,
    end: 0,
    statusCode: 204,
    statusMessage: 'No Content',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(key, value)
  const result = store.get(key)
  t.ok(result)
  t.equal(result.statusCode, 204)
  t.equal(result.body, undefined)
  t.end()
})

test('assertCacheKey - throws on invalid key', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(() => store.get(null), /expected key to be object/)
  t.throws(() => store.get('string'), /expected key to be object/)
  t.throws(() => store.get({ method: 'GET', path: '/' }), /expected key.origin to be string/)
  t.throws(
    () => store.get({ origin: 'https://example.com', path: '/' }),
    /expected key.method to be string/,
  )
  t.throws(
    () => store.get({ origin: 'https://example.com', method: 'GET' }),
    /expected key.path to be string/,
  )
  t.end()
})

test('assertCacheValue - throws on invalid value', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/test' }

  t.throws(() => store.set(key, null), /expected value to be object/)
  t.throws(
    () =>
      store.set(key, {
        statusCode: 'not-a-number',
        statusMessage: 'OK',
        cachedAt: 0,
        staleAt: 0,
        deleteAt: 0,
        body: null,
        start: 0,
        end: 0,
      }),
    /expected value.statusCode to be number/,
  )
  t.end()
})

test('etag stored and retrieved', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/etag' }
  const now = Date.now()
  const value = {
    body: Buffer.from('data'),
    start: 0,
    end: 4,
    statusCode: 200,
    statusMessage: 'OK',
    etag: '"abc123"',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(key, value)
  const result = store.get(key)
  t.ok(result)
  t.equal(result.etag, '"abc123"')
  t.end()
})

test('cacheControlDirectives stored and retrieved', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/cc' }
  const now = Date.now()
  const value = {
    body: Buffer.from('data'),
    start: 0,
    end: 4,
    statusCode: 200,
    statusMessage: 'OK',
    cacheControlDirectives: { 'max-age': 3600, public: true },
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(key, value)
  const result = store.get(key)
  t.ok(result)
  t.strictSame(result.cacheControlDirectives, { 'max-age': 3600, public: true })
  t.end()
})

test('duplicate set inserts both entries', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/overwrite' }
  const now = Date.now()

  store.set(key, {
    body: Buffer.from('first'),
    start: 0,
    end: 5,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  })

  store.set(key, {
    body: Buffer.from('second'),
    start: 0,
    end: 6,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now + 1,
    staleAt: now + 3601e3,
    deleteAt: now + 7201e3,
  })

  // get returns the entry with the earliest deleteAt (ORDER BY deleteAt ASC)
  const result = store.get(key)
  t.ok(result)
  t.equal(result.body.toString(), 'first')
  t.equal(result.cachedAt, now)
  t.end()
})

test('different methods are distinct keys', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const base = {
    body: null,
    start: 0,
    end: 0,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(
    { origin: 'https://example.com', method: 'GET', path: '/method' },
    { ...base, statusCode: 200 },
  )
  store.set(
    { origin: 'https://example.com', method: 'HEAD', path: '/method' },
    { ...base, statusCode: 204 },
  )

  const getResult = store.get({ origin: 'https://example.com', method: 'GET', path: '/method' })
  const headResult = store.get({ origin: 'https://example.com', method: 'HEAD', path: '/method' })
  t.ok(getResult)
  t.ok(headResult)
  t.equal(getResult.statusCode, 200)
  t.equal(headResult.statusCode, 204)
  t.end()
})

test('different origins are distinct keys', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const base = {
    body: null,
    start: 0,
    end: 0,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(
    { origin: 'https://a.com', method: 'GET', path: '/shared' },
    { ...base, statusCode: 200 },
  )
  store.set(
    { origin: 'https://b.com', method: 'GET', path: '/shared' },
    { ...base, statusCode: 404 },
  )

  const a = store.get({ origin: 'https://a.com', method: 'GET', path: '/shared' })
  const b = store.get({ origin: 'https://b.com', method: 'GET', path: '/shared' })
  t.ok(a)
  t.ok(b)
  t.equal(a.statusCode, 200)
  t.equal(b.statusCode, 404)
  t.end()
})

test('different paths are distinct keys', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const base = {
    body: null,
    start: 0,
    end: 0,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(
    { origin: 'https://example.com', method: 'GET', path: '/a' },
    { ...base, statusCode: 200 },
  )
  store.set(
    { origin: 'https://example.com', method: 'GET', path: '/b' },
    { ...base, statusCode: 404 },
  )

  const a = store.get({ origin: 'https://example.com', method: 'GET', path: '/a' })
  const b = store.get({ origin: 'https://example.com', method: 'GET', path: '/b' })
  t.ok(a)
  t.ok(b)
  t.equal(a.statusCode, 200)
  t.equal(b.statusCode, 404)
  t.end()
})

test('multiple vary variants for same URL', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const base = {
    start: 0,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(
    {
      origin: 'https://example.com',
      method: 'GET',
      path: '/multi-vary',
      headers: { accept: 'text/html' },
    },
    { ...base, body: Buffer.from('html'), end: 4, vary: { accept: 'text/html' } },
  )
  store.set(
    {
      origin: 'https://example.com',
      method: 'GET',
      path: '/multi-vary',
      headers: { accept: 'application/json' },
    },
    { ...base, body: Buffer.from('json'), end: 4, vary: { accept: 'application/json' } },
  )

  const html = store.get({
    origin: 'https://example.com',
    method: 'GET',
    path: '/multi-vary',
    headers: { accept: 'text/html' },
  })
  const json = store.get({
    origin: 'https://example.com',
    method: 'GET',
    path: '/multi-vary',
    headers: { accept: 'application/json' },
  })
  const xml = store.get({
    origin: 'https://example.com',
    method: 'GET',
    path: '/multi-vary',
    headers: { accept: 'application/xml' },
  })

  t.ok(html)
  t.equal(html.body.toString(), 'html')
  t.ok(json)
  t.equal(json.body.toString(), 'json')
  t.equal(xml, undefined)
  t.end()
})

test('vary with no matching request header returns undefined', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    {
      origin: 'https://example.com',
      method: 'GET',
      path: '/vary-miss',
      headers: { 'accept-encoding': 'gzip' },
    },
    {
      body: Buffer.from('data'),
      start: 0,
      end: 4,
      statusCode: 200,
      statusMessage: 'OK',
      vary: { 'accept-encoding': 'gzip' },
      cachedAt: now,
      staleAt: now + 3600e3,
      deleteAt: now + 7200e3,
    },
  )

  // Request with no headers at all
  const result = store.get({ origin: 'https://example.com', method: 'GET', path: '/vary-miss' })
  t.equal(result, undefined)
  t.end()
})

test('range header - array range returns undefined', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    { origin: 'https://example.com', method: 'GET', path: '/range-arr' },
    {
      body: Buffer.from('data'),
      start: 0,
      end: 4,
      statusCode: 200,
      statusMessage: 'OK',
      cachedAt: now,
      staleAt: now + 3600e3,
      deleteAt: now + 7200e3,
    },
  )

  const result = store.get({
    origin: 'https://example.com',
    method: 'GET',
    path: '/range-arr',
    headers: { range: ['bytes=0-1', 'bytes=2-3'] },
  })
  t.equal(result, undefined)
  t.end()
})

test('range header - valid range matches stored range', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    { origin: 'https://example.com', method: 'GET', path: '/range' },
    {
      body: Buffer.from('partial'),
      start: 10,
      end: 17,
      statusCode: 206,
      statusMessage: 'Partial Content',
      cachedAt: now,
      staleAt: now + 3600e3,
      deleteAt: now + 7200e3,
    },
  )

  // Matching range
  const result = store.get({
    origin: 'https://example.com',
    method: 'GET',
    path: '/range',
    headers: { range: 'bytes=10-16' },
  })
  t.ok(result)
  t.equal(result.body.toString(), 'partial')

  // Non-matching range
  const miss = store.get({
    origin: 'https://example.com',
    method: 'GET',
    path: '/range',
    headers: { range: 'bytes=0-5' },
  })
  t.equal(miss, undefined)
  t.end()
})

test('invalid range header returns undefined', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    { origin: 'https://example.com', method: 'GET', path: '/bad-range' },
    {
      body: Buffer.from('data'),
      start: 0,
      end: 4,
      statusCode: 200,
      statusMessage: 'OK',
      cachedAt: now,
      staleAt: now + 3600e3,
      deleteAt: now + 7200e3,
    },
  )

  const result = store.get({
    origin: 'https://example.com',
    method: 'GET',
    path: '/bad-range',
    headers: { range: 'invalid-range' },
  })
  t.equal(result, undefined)
  t.end()
})

test('large body round-trip', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/large' }
  const now = Date.now()
  const largeBody = Buffer.alloc(1024 * 1024, 'x')
  const value = {
    body: largeBody,
    start: 0,
    end: largeBody.byteLength,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  store.set(key, value)
  const result = store.get(key)
  t.ok(result)
  t.equal(result.body.byteLength, 1024 * 1024)
  t.ok(result.body.equals(largeBody))
  t.end()
})

test('file-based store persists data', (t) => {
  const dbPath = path.join(os.tmpdir(), `cache-test-${Date.now()}.sqlite`)
  t.teardown(() => {
    try {
      fs.unlinkSync(dbPath)
    } catch {}
    try {
      fs.unlinkSync(dbPath + '-wal')
    } catch {}
    try {
      fs.unlinkSync(dbPath + '-shm')
    } catch {}
  })

  const key = { origin: 'https://example.com', method: 'GET', path: '/persist' }
  const now = Date.now()
  const value = {
    body: Buffer.from('persisted'),
    start: 0,
    end: 9,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  }

  // Write with one store instance
  const store1 = new SqliteCacheStore({ location: dbPath })
  store1.set(key, value)
  store1.close()

  // Read with a new store instance
  const store2 = new SqliteCacheStore({ location: dbPath })
  t.teardown(() => store2.close())
  const result = store2.get(key)
  t.ok(result)
  t.equal(result.body.toString(), 'persisted')
  t.end()
})

test('cachedAt, staleAt, deleteAt round-trip', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/timestamps' }
  const now = Date.now()
  const value = {
    body: Buffer.from('ts'),
    start: 0,
    end: 2,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 1800e3,
    deleteAt: now + 3600e3,
  }

  store.set(key, value)
  const result = store.get(key)
  t.ok(result)
  t.equal(result.cachedAt, now)
  t.equal(result.staleAt, now + 1800e3)
  t.equal(result.deleteAt, now + 3600e3)
  t.end()
})

test('vary round-trip preserves vary object', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const vary = { 'accept-encoding': 'gzip', 'accept-language': 'en' }
  store.set(
    {
      origin: 'https://example.com',
      method: 'GET',
      path: '/vary-rt',
      headers: { 'accept-encoding': 'gzip', 'accept-language': 'en' },
    },
    {
      body: Buffer.from('v'),
      start: 0,
      end: 1,
      statusCode: 200,
      statusMessage: 'OK',
      vary,
      cachedAt: now,
      staleAt: now + 3600e3,
      deleteAt: now + 7200e3,
    },
  )

  const result = store.get({
    origin: 'https://example.com',
    method: 'GET',
    path: '/vary-rt',
    headers: { 'accept-encoding': 'gzip', 'accept-language': 'en' },
  })
  t.ok(result)
  t.strictSame(result.vary, vary)
  t.end()
})

test('assertCacheValue - throws on invalid statusMessage', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/test' }

  t.throws(
    () =>
      store.set(key, {
        statusCode: 200,
        statusMessage: 123,
        cachedAt: 0,
        staleAt: 0,
        deleteAt: 0,
        body: null,
        start: 0,
        end: 0,
      }),
    /expected value.statusMessage to be string/,
  )
  t.end()
})

test('assertCacheValue - throws on invalid cachedAt', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/test' }

  t.throws(
    () =>
      store.set(key, {
        statusCode: 200,
        statusMessage: 'OK',
        cachedAt: 'bad',
        staleAt: 0,
        deleteAt: 0,
        body: null,
        start: 0,
        end: 0,
      }),
    /expected value.cachedAt to be number/,
  )
  t.end()
})

test('assertCacheValue - throws on invalid headers type', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/test' }

  t.throws(
    () =>
      store.set(key, {
        statusCode: 200,
        statusMessage: 'OK',
        cachedAt: 0,
        staleAt: 0,
        deleteAt: 0,
        body: null,
        start: 0,
        end: 0,
        headers: 'not-an-object',
      }),
    /expected value.rawHeaders to be object/,
  )
  t.end()
})

test('assertCacheValue - throws on invalid vary type', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/test' }

  t.throws(
    () =>
      store.set(key, {
        statusCode: 200,
        statusMessage: 'OK',
        cachedAt: 0,
        staleAt: 0,
        deleteAt: 0,
        body: null,
        start: 0,
        end: 0,
        vary: 'not-an-object',
      }),
    /expected value.vary to be object/,
  )
  t.end()
})

test('assertCacheValue - throws on invalid etag type', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/test' }

  t.throws(
    () =>
      store.set(key, {
        statusCode: 200,
        statusMessage: 'OK',
        cachedAt: 0,
        staleAt: 0,
        deleteAt: 0,
        body: null,
        start: 0,
        end: 0,
        etag: 123,
      }),
    /expected value.etag to be string/,
  )
  t.end()
})

test('assertCacheKey - throws on invalid headers type', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(
    () => store.get({ origin: 'https://example.com', method: 'GET', path: '/', headers: 'bad' }),
    /expected headers to be object/,
  )
  t.end()
})

test('result has no body field when stored body is null', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/no-body' }
  const now = Date.now()
  store.set(key, {
    body: null,
    start: 0,
    end: 0,
    statusCode: 304,
    statusMessage: 'Not Modified',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  })

  const result = store.get(key)
  t.ok(result)
  t.equal(result.body, undefined)
  t.equal(result.statusCode, 304)
  t.end()
})

test('result omits undefined optional fields', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = { origin: 'https://example.com', method: 'GET', path: '/minimal' }
  const now = Date.now()
  store.set(key, {
    body: Buffer.from('x'),
    start: 0,
    end: 1,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  })

  const result = store.get(key)
  t.ok(result)
  t.equal(result.etag, undefined)
  t.equal(result.vary, undefined)
  t.equal(result.headers, undefined)
  t.equal(result.cacheControlDirectives, undefined)
  t.end()
})
