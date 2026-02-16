/* eslint-disable */
import { test } from 'tap'
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
