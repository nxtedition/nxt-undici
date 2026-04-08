/* eslint-disable */
import { test } from 'tap'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
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
    deleteAt: now + 7200e3,
    ...overrides,
  }
}

// set() is async (batched via setImmediate). Call flush() before get() to
// ensure the write has reached the database.
const flush = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// Async flush semantics
// ---------------------------------------------------------------------------

test('set() is immediately visible via get() before flush (batch read-through)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/async' }), makeValue())
  t.ok(store.get(makeKey({ path: '/async' })), 'visible in batch before flush')
  await flush()
  t.ok(store.get(makeKey({ path: '/async' })), 'still visible after flush (now in DB)')
  t.end()
})

test('multiple sets in the same tick are batched into a single flush', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  for (let i = 0; i < 10; i++) {
    store.set(
      makeKey({ path: `/batch-${i}` }),
      makeValue({ body: Buffer.from(`item${i}`), end: 4 + String(i).length, cachedAt: now + i }),
    )
  }
  t.ok(store.get(makeKey({ path: '/batch-0' })), 'visible in batch before flush')
  await flush()
  for (let i = 0; i < 10; i++) {
    t.ok(store.get(makeKey({ path: `/batch-${i}` })), `item ${i} visible after flush`)
  }
  t.end()
})

test('batch read-through: expired batch entry is not returned by get()', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const past = Date.now() - 10000
  store.set(makeKey({ path: '/expired-batch' }), makeValue({ deleteAt: past, cachedAt: past - 2 }))
  // Not flushed yet — entry lives only in the batch. It is expired, so get() must return undefined.
  t.equal(
    store.get(makeKey({ path: '/expired-batch' })),
    undefined,
    'expired batch entry must not be returned',
  )
  t.end()
})

test('batch read-through: vary matching is applied to batch entries', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/vary-batch', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )
  // Hit — same vary header value, not yet flushed.
  t.ok(
    store.get(makeKey({ path: '/vary-batch', headers: { 'accept-encoding': 'gzip' } })),
    'vary match in batch',
  )
  // Miss — different value.
  t.equal(
    store.get(makeKey({ path: '/vary-batch', headers: { 'accept-encoding': 'br' } })),
    undefined,
    'vary mismatch in batch',
  )
  // Miss — header absent.
  t.equal(store.get(makeKey({ path: '/vary-batch' })), undefined, 'missing header miss in batch')
  t.end()
})

// ---------------------------------------------------------------------------
// Basic get / set round-trip
// ---------------------------------------------------------------------------

test('basic get/set round-trip', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = makeKey()
  const now = Date.now()
  const value = makeValue({
    body: Buffer.from('hello world'),
    end: 11,
    headers: { 'content-type': 'text/plain' },
    cachedAt: now,
    deleteAt: now + 7200e3,
  })

  store.set(key, value)
  await flush()
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

  t.equal(store.get(makeKey({ path: '/missing' })), undefined)
  t.end()
})

test('get returns undefined for expired entry', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const past = Date.now() - 10000
  store.set(makeKey({ path: '/expired' }), makeValue({ deleteAt: past, cachedAt: past - 2 }))
  await flush()
  t.equal(store.get(makeKey({ path: '/expired' })), undefined)
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fix: expired entry must not block valid entries in the same result set
// ---------------------------------------------------------------------------

test('expired entry does not block valid entry with later deleteAt (bug fix)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const past = now - 10000

  store.set(
    makeKey({ path: '/overlap', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({
      vary: { 'accept-encoding': 'gzip' },
      deleteAt: past,
      cachedAt: past - 2,
    }),
  )
  store.set(
    makeKey({ path: '/overlap', headers: { 'accept-encoding': 'deflate' } }),
    makeValue({
      body: Buffer.from('deflate-body'),
      end: 12,
      vary: { 'accept-encoding': 'deflate' },
      cachedAt: now,
      deleteAt: now + 7200e3,
    }),
  )

  await flush()
  const result = store.get(makeKey({ path: '/overlap', headers: { 'accept-encoding': 'deflate' } }))
  t.ok(result, 'should find the valid entry despite expired entry existing')
  t.equal(result.body.toString(), 'deflate-body')
  t.end()
})

test('expired entry with matching vary must not be returned (bug fix)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const past = Date.now() - 10000
  store.set(
    makeKey({ headers: { 'accept-encoding': 'gzip' } }),
    makeValue({
      vary: { 'accept-encoding': 'gzip' },
      deleteAt: past,
      cachedAt: past - 2,
    }),
  )

  await flush()
  t.equal(store.get(makeKey({ headers: { 'accept-encoding': 'gzip' } })), undefined)
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fix: makeValueUrl — no double slash when path starts with "/"
// ---------------------------------------------------------------------------

test('path starting with / is stored and looked up correctly (no double-slash key)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/foo/bar' }), makeValue())
  await flush()
  t.ok(store.get(makeKey({ path: '/foo/bar' })))
  t.equal(store.get(makeKey({ path: '//foo/bar' })), undefined)
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fix: assertCacheKey error message
// ---------------------------------------------------------------------------

test('assertCacheKey error message contains actual type, not "string"', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  try {
    store.get(42)
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /number/, 'error message should say "number"')
    t.notMatch(err.message, /^expected key to be object, got string/, 'must not say "string"')
  }

  try {
    store.get(null)
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /null/)
  }

  t.end()
})

// ---------------------------------------------------------------------------
// SQLITE_FULL handling — batch flush with eviction
// ---------------------------------------------------------------------------

test('batch flush handles SQLITE_FULL with eviction and retries', async (t) => {
  const store = new SqliteCacheStore({ maxSize: 4096 * 6 })
  t.teardown(() => store.close())

  const past = Date.now() - 120e3
  const largeBody = Buffer.alloc(1024, 'x')

  // Fill DB with expired entries.
  for (let i = 0; i < 20; i++) {
    store.set(
      makeKey({ path: `/fill-${i}` }),
      makeValue({
        body: largeBody,
        end: largeBody.byteLength,
        deleteAt: past,
        cachedAt: past - 2,
      }),
    )
  }
  await flush()

  // Fresh entry — eviction must free space during flush.
  const now = Date.now()
  store.set(
    makeKey({ path: '/after-evict' }),
    makeValue({
      body: Buffer.from('new'),
      end: 3,
      cachedAt: now,
      deleteAt: now + 7200e3,
    }),
  )
  await flush()

  const result = store.get(makeKey({ path: '/after-evict' }))
  t.ok(result)
  t.equal(result.body.toString(), 'new')
  t.end()
})

test('flush emits warning for body too large to fit after eviction', async (t) => {
  const maxSize = 4096 * 6
  const store = new SqliteCacheStore({ maxSize })
  t.teardown(() => store.close())

  const warnings = []
  const onWarning = (w) => warnings.push(w)
  process.on('warning', onWarning)
  t.teardown(() => process.off('warning', onWarning))

  const tooBig = Buffer.alloc(maxSize, 'x')
  const now = Date.now()
  store.set(
    makeKey({ path: '/too-big' }),
    makeValue({
      body: tooBig,
      end: tooBig.byteLength,
      cachedAt: now,
      deleteAt: now + 7200e3,
    }),
  )
  await flush()

  t.ok(warnings.length > 0, 'warning emitted for oversized entry')
  t.end()
})

test('SQLITE_FULL on BEGIN: eviction is triggered and entry is stored on retry', async (t) => {
  const { DatabaseSync } = await import('node:sqlite')
  const AnyDB = /** @type {any} */ (DatabaseSync)

  let beginFailed = false
  const origExec = AnyDB.prototype.exec
  AnyDB.prototype.exec = function (/** @type {string} */ sql) {
    if (sql === 'BEGIN' && !beginFailed) {
      beginFailed = true
      throw Object.assign(new Error('disk or database is full'), { errcode: 13 })
    }
    return origExec.call(this, sql)
  }

  const store = new SqliteCacheStore()

  t.teardown(() => {
    AnyDB.prototype.exec = origExec
    store.close()
  })

  store.set(makeKey({ path: '/begin-fail-once' }), makeValue())

  // Two ticks: first flush hits the patched BEGIN, second succeeds on retry.
  await flush()
  await flush()

  t.ok(
    store.get(makeKey({ path: '/begin-fail-once' })),
    'entry stored after BEGIN-failure recovery',
  )
  t.end()
})

test('SQLITE_FULL on BEGIN: batch is cleared after retries exhausted (no infinite loop)', async (t) => {
  const { DatabaseSync } = await import('node:sqlite')
  const AnyDB = /** @type {any} */ (DatabaseSync)

  const origExec = AnyDB.prototype.exec
  AnyDB.prototype.exec = function (/** @type {string} */ sql) {
    if (sql === 'BEGIN') {
      throw Object.assign(new Error('disk or database is full'), { errcode: 13 })
    }
    return origExec.call(this, sql)
  }

  /** @type {Error[]} */
  const warnings = []
  const onWarning = (/** @type {Error} */ w) => warnings.push(w)
  process.on('warning', onWarning)

  const store = new SqliteCacheStore()

  t.teardown(() => {
    process.off('warning', onWarning)
    AnyDB.prototype.exec = origExec
    store.close()
  })

  store.set(makeKey({ path: '/begin-always-fail' }), makeValue())

  // With the old code this would loop indefinitely (one warning per tick).
  // With the fix the batch is cleared after 3 retries → exactly one warning.
  for (let i = 0; i < 10; i++) await flush()

  t.equal(warnings.length, 1, 'exactly one warning after retries exhausted')
  t.end()
})

test('set() never throws — DB errors surface as process warnings', async (t) => {
  const store = new SqliteCacheStore({ maxSize: 4096 * 6 })
  t.teardown(() => store.close())

  const body = Buffer.alloc(512, 'x')
  const now = Date.now()

  t.doesNotThrow(() => {
    for (let i = 0; i < 200; i++) {
      store.set(
        makeKey({ path: `/db-err-${i}` }),
        makeValue({
          body,
          end: body.byteLength,
          cachedAt: now,
          deleteAt: now + 7200e3 + i,
        }),
      )
    }
  })
  await flush()
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fix: re-cached entry must be returned, not the stale duplicate
// ---------------------------------------------------------------------------

test('re-caching same key returns the freshest entry (cachedAt DESC fix)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const key = makeKey({ path: '/revalidated' })

  store.set(
    key,
    makeValue({
      body: Buffer.from('old'),
      end: 3,
      cachedAt: now - 5000,
      deleteAt: now + 1000,
    }),
  )
  await flush()

  store.set(
    key,
    makeValue({
      body: Buffer.from('fresh'),
      end: 5,
      cachedAt: now,
      deleteAt: now + 7200e3,
    }),
  )
  await flush()

  const result = store.get(key)
  t.ok(result)
  t.equal(result.body.toString(), 'fresh', 'must return the most recently cached entry')
  t.end()
})

// ---------------------------------------------------------------------------
// purgeStale
// ---------------------------------------------------------------------------

test('purgeStale always deletes expired entries regardless of call frequency', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const past = Date.now() - 120e3
  const key = makeKey({ path: '/purge-test' })

  store.set(key, makeValue({ deleteAt: past, cachedAt: past - 2 }))
  await flush()

  store.purgeStale()
  store.purgeStale()

  const now = Date.now()
  store.set(
    key,
    makeValue({
      body: Buffer.from('fresh'),
      end: 5,
      cachedAt: now,
      deleteAt: now + 7200e3,
    }),
  )
  await flush()
  const result = store.get(key)
  t.ok(result)
  t.equal(result.body.toString(), 'fresh')
  t.end()
})

// ---------------------------------------------------------------------------
// Vary header matching
// ---------------------------------------------------------------------------

test('vary header matching — hit', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )
  await flush()

  t.ok(store.get(makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } })))
  t.end()
})

test('vary header matching — miss on different value', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )
  await flush()

  t.equal(store.get(makeKey({ path: '/vary', headers: { 'accept-encoding': 'br' } })), undefined)
  t.end()
})

test('vary header matching — miss when request has no matching header', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )
  await flush()

  t.equal(store.get(makeKey({ path: '/vary' })), undefined)
  t.end()
})

test('multiple vary variants for the same URL', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/mv', headers: { accept: 'text/html' } }),
    makeValue({ body: Buffer.from('html'), end: 4, vary: { accept: 'text/html' } }),
  )
  store.set(
    makeKey({ path: '/mv', headers: { accept: 'application/json' } }),
    makeValue({ body: Buffer.from('json'), end: 4, vary: { accept: 'application/json' } }),
  )
  await flush()

  t.equal(
    store.get(makeKey({ path: '/mv', headers: { accept: 'text/html' } })).body.toString(),
    'html',
  )
  t.equal(
    store.get(makeKey({ path: '/mv', headers: { accept: 'application/json' } })).body.toString(),
    'json',
  )
  t.equal(store.get(makeKey({ path: '/mv', headers: { accept: 'application/xml' } })), undefined)
  t.end()
})

test('vary with array header values — all elements must match', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/vary-arr', headers: { 'accept-encoding': ['gzip', 'br'] } }),
    makeValue({ vary: { 'accept-encoding': ['gzip', 'br'] } }),
  )
  await flush()

  t.ok(store.get(makeKey({ path: '/vary-arr', headers: { 'accept-encoding': ['gzip', 'br'] } })))
  t.equal(
    store.get(makeKey({ path: '/vary-arr', headers: { 'accept-encoding': ['br', 'gzip'] } })),
    undefined,
    'different order must not match',
  )
  t.equal(
    store.get(makeKey({ path: '/vary-arr', headers: { 'accept-encoding': ['gzip'] } })),
    undefined,
    'subset must not match',
  )
  t.end()
})

test('multi-header vary — all headers must match', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/mv2', headers: { 'accept-encoding': 'gzip', 'accept-language': 'en' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip', 'accept-language': 'en' } }),
  )
  await flush()

  t.ok(
    store.get(
      makeKey({ path: '/mv2', headers: { 'accept-encoding': 'gzip', 'accept-language': 'en' } }),
    ),
  )
  t.equal(
    store.get(
      makeKey({ path: '/mv2', headers: { 'accept-encoding': 'gzip', 'accept-language': 'fr' } }),
    ),
    undefined,
  )
  t.equal(store.get(makeKey({ path: '/mv2', headers: { 'accept-encoding': 'gzip' } })), undefined)
  t.end()
})

// ---------------------------------------------------------------------------
// Range header handling
// ---------------------------------------------------------------------------

test('range header — array range returns undefined', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey(), makeValue())
  await flush()

  t.equal(store.get(makeKey({ headers: { range: ['bytes=0-1', 'bytes=2-3'] } })), undefined)
  t.end()
})

test('range header — invalid range string returns undefined', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey(), makeValue())
  await flush()

  t.equal(store.get(makeKey({ headers: { range: 'invalid' } })), undefined)
  t.end()
})

test('range header — exact match on both start and end returns entry', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/range' }),
    makeValue({
      body: Buffer.from('partial'),
      start: 10,
      end: 17,
      statusCode: 206,
      statusMessage: 'Partial Content',
    }),
  )
  await flush()

  const hit = store.get(makeKey({ path: '/range', headers: { range: 'bytes=10-16' } }))
  t.ok(hit)
  t.equal(hit.body.toString(), 'partial')
  t.equal(hit.statusCode, 206)
  t.end()
})

test('range header — start in range but end mismatch → miss (covers loop continue)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/range-end-mismatch' }),
    makeValue({ body: Buffer.alloc(100, 'x'), start: 0, end: 100, statusCode: 200 }),
  )
  await flush()

  t.equal(
    store.get(makeKey({ path: '/range-end-mismatch', headers: { range: 'bytes=0-49' } })),
    undefined,
    'different end must not match',
  )
  t.end()
})

test('range header — requested start differs from stored start → miss (covers loop continue)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/range-start-mismatch' }),
    makeValue({ body: Buffer.alloc(100, 'y'), start: 0, end: 100, statusCode: 200 }),
  )
  await flush()

  t.equal(
    store.get(makeKey({ path: '/range-start-mismatch', headers: { range: 'bytes=5-9' } })),
    undefined,
    'start mismatch must not match',
  )
  t.end()
})

test('range header — request for different byte window than stored → miss', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/range' }),
    makeValue({
      body: Buffer.from('partial'),
      start: 10,
      end: 17,
      statusCode: 206,
      statusMessage: 'Partial Content',
    }),
  )
  await flush()

  t.equal(store.get(makeKey({ path: '/range', headers: { range: 'bytes=0-5' } })), undefined)
  t.equal(store.get(makeKey({ path: '/range', headers: { range: 'bytes=10-20' } })), undefined)
  t.end()
})

test('range header — open-ended range (bytes=N-) returns undefined', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/range-open' }),
    makeValue({ body: Buffer.alloc(100, 'z'), start: 0, end: 100, statusCode: 200 }),
  )
  await flush()

  t.equal(
    store.get(makeKey({ path: '/range-open', headers: { range: 'bytes=0-' } })),
    undefined,
    'open-ended range must not match',
  )
  t.end()
})

test('non-range request does not return a partial (start > 0) cached entry', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/partial' }),
    makeValue({
      body: Buffer.from('partial'),
      start: 10,
      end: 17,
      statusCode: 206,
      statusMessage: 'Partial Content',
    }),
  )
  await flush()

  t.equal(store.get(makeKey({ path: '/partial' })), undefined)
  t.end()
})

test('non-range request returns a full cached response (start=0)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/full-non-range' }),
    makeValue({ body: Buffer.from('full body'), start: 0, end: 9, statusCode: 200 }),
  )
  await flush()

  const result = store.get(makeKey({ path: '/full-non-range' }))
  t.ok(result)
  t.equal(result.body.toString(), 'full body')
  t.end()
})

// ---------------------------------------------------------------------------
// Body variants
// ---------------------------------------------------------------------------

test('set with array body', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/arr' }),
    makeValue({ body: [Buffer.from('hello'), Buffer.from(' world')], end: 11 }),
  )
  await flush()

  t.equal(store.get(makeKey({ path: '/arr' })).body.toString(), 'hello world')
  t.end()
})

test('set with null body', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/null' }),
    makeValue({ body: null, end: 0, statusCode: 204, statusMessage: 'No Content' }),
  )
  await flush()

  const result = store.get(makeKey({ path: '/null' }))
  t.ok(result)
  t.equal(result.statusCode, 204)
  t.equal(result.body, undefined)
  t.end()
})

test('large body round-trip', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const largeBody = Buffer.alloc(1024 * 1024, 'x')
  store.set(makeKey({ path: '/large' }), makeValue({ body: largeBody, end: largeBody.byteLength }))
  await flush()

  const result = store.get(makeKey({ path: '/large' }))
  t.ok(result)
  t.equal(result.body.byteLength, 1024 * 1024)
  t.ok(result.body.equals(largeBody))
  t.end()
})

// ---------------------------------------------------------------------------
// Key distinctness
// ---------------------------------------------------------------------------

test('different methods are distinct keys', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ method: 'GET', path: '/m' }),
    makeValue({ statusCode: 200, body: null, end: 0 }),
  )
  store.set(
    makeKey({ method: 'HEAD', path: '/m' }),
    makeValue({ statusCode: 204, body: null, end: 0 }),
  )
  await flush()

  t.equal(store.get(makeKey({ method: 'GET', path: '/m' })).statusCode, 200)
  t.equal(store.get(makeKey({ method: 'HEAD', path: '/m' })).statusCode, 204)
  t.end()
})

test('different origins are distinct keys', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ origin: 'https://a.com', path: '/x' }),
    makeValue({ statusCode: 200, body: null, end: 0 }),
  )
  store.set(
    makeKey({ origin: 'https://b.com', path: '/x' }),
    makeValue({ statusCode: 404, body: null, end: 0 }),
  )
  await flush()

  t.equal(store.get(makeKey({ origin: 'https://a.com', path: '/x' })).statusCode, 200)
  t.equal(store.get(makeKey({ origin: 'https://b.com', path: '/x' })).statusCode, 404)
  t.end()
})

test('different paths are distinct keys', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/a' }), makeValue({ statusCode: 200, body: null, end: 0 }))
  store.set(makeKey({ path: '/b' }), makeValue({ statusCode: 404, body: null, end: 0 }))
  await flush()

  t.equal(store.get(makeKey({ path: '/a' })).statusCode, 200)
  t.equal(store.get(makeKey({ path: '/b' })).statusCode, 404)
  t.end()
})

// ---------------------------------------------------------------------------
// Duplicate inserts and ordering
// ---------------------------------------------------------------------------

test('duplicate set inserts both entries; get returns most recently cached entry (cachedAt DESC)', async (t) => {
  // With ORDER BY cachedAt DESC the entry with the highest cachedAt wins.
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    makeKey({ path: '/dup' }),
    makeValue({ body: Buffer.from('first'), end: 5, cachedAt: now, deleteAt: now + 7200e3 }),
  )
  store.set(
    makeKey({ path: '/dup' }),
    // Strictly higher cachedAt so ordering is deterministic.
    makeValue({ body: Buffer.from('second'), end: 6, cachedAt: now + 1, deleteAt: now + 7201e3 }),
  )
  await flush()

  const result = store.get(makeKey({ path: '/dup' }))
  t.ok(result)
  t.equal(result.body.toString(), 'second', 'most recently cached entry wins')
  t.end()
})

// ---------------------------------------------------------------------------
// Optional fields round-trip
// ---------------------------------------------------------------------------

test('etag stored and retrieved', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/etag' }), makeValue({ etag: '"abc123"' }))
  await flush()
  t.equal(store.get(makeKey({ path: '/etag' })).etag, '"abc123"')
  t.end()
})

test('cacheControlDirectives stored and retrieved', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/cc' }),
    makeValue({ cacheControlDirectives: { 'max-age': 3600, public: true } }),
  )
  await flush()
  t.strictSame(store.get(makeKey({ path: '/cc' })).cacheControlDirectives, {
    'max-age': 3600,
    public: true,
  })
  t.end()
})

test('cachedAt, deleteAt round-trip', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(makeKey({ path: '/ts' }), makeValue({ cachedAt: now, deleteAt: now + 3600e3 }))
  await flush()

  const result = store.get(makeKey({ path: '/ts' }))
  t.equal(result.cachedAt, now)
  t.equal(result.deleteAt, now + 3600e3)
  t.end()
})

test('result omits undefined optional fields when not set', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/minimal' }), makeValue({ body: Buffer.from('x'), end: 1 }))
  await flush()

  const result = store.get(makeKey({ path: '/minimal' }))
  t.ok(result)
  t.equal(result.etag, undefined)
  t.equal(result.vary, undefined)
  t.equal(result.headers, undefined)
  t.equal(result.cacheControlDirectives, undefined)
  t.end()
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('file-based store persists data across instances', (t) => {
  // close() flushes pending items synchronously before closing the DB,
  // so data written with set() is always readable by the next instance.
  const dbPath = path.join(os.tmpdir(), `cache-test-${Date.now()}.sqlite`)
  t.teardown(() => {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + ext)
      } catch {}
    }
  })

  const store1 = new SqliteCacheStore({ location: dbPath })
  store1.set(makeKey({ path: '/persist' }), makeValue({ body: Buffer.from('persisted'), end: 9 }))
  store1.close() // Must flush before closing.

  const store2 = new SqliteCacheStore({ location: dbPath })
  t.teardown(() => store2.close())
  const result = store2.get(makeKey({ path: '/persist' }))
  t.ok(result)
  t.equal(result.body.toString(), 'persisted')
  t.end()
})

// ---------------------------------------------------------------------------
// close() flushes pending items
// ---------------------------------------------------------------------------

test('close() flushes pending items before closing the DB', (t) => {
  const dbPath = path.join(os.tmpdir(), `cache-close-${Date.now()}.sqlite`)
  t.teardown(() => {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + ext)
      } catch {}
    }
  })

  const store = new SqliteCacheStore({ location: dbPath })
  store.set(makeKey({ path: '/pending' }), makeValue({ body: Buffer.from('data'), end: 4 }))
  // No await — close() must flush synchronously.
  store.close()

  const store2 = new SqliteCacheStore({ location: dbPath })
  t.teardown(() => store2.close())
  const result = store2.get(makeKey({ path: '/pending' }))
  t.ok(result, 'pending item must be persisted by close()')
  t.equal(result.body.toString(), 'data')
  t.end()
})

test('close removes store from global set; subsequent get() returns undefined, set() silently discards', async (t) => {
  const store = new SqliteCacheStore()
  store.set(makeKey(), makeValue())
  store.close()

  // get() returns undefined after close — does not throw.
  t.equal(store.get(makeKey()), undefined)
  // set() after close silently discards — no throw, no warning, no setImmediate.
  t.doesNotThrow(() => store.set(makeKey(), makeValue()))
  await flush()
  t.end()
})

// ---------------------------------------------------------------------------
// Validation: assertCacheKey
// ---------------------------------------------------------------------------

test('assertCacheKey — throws on non-object', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(() => store.get(null), /expected key to be object/)
  t.throws(() => store.get('string'), /expected key to be object/)
  t.throws(() => store.get(42), /expected key to be object/)
  t.end()
})

test('assertCacheKey — throws on missing required string fields', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

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

test('assertCacheKey — throws on non-object headers', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(() => store.get(makeKey({ headers: 'bad' })), /expected headers to be object/)
  t.end()
})

// ---------------------------------------------------------------------------
// Validation: assertCacheValue
// ---------------------------------------------------------------------------

test('assertCacheValue — throws on non-object value', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(() => store.set(makeKey(), null), /expected value to be object/)
  t.throws(() => store.set(makeKey(), 'bad'), /expected value to be object/)
  t.end()
})

test('assertCacheValue — throws on non-number numeric fields', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  for (const field of ['statusCode', 'cachedAt', 'deleteAt']) {
    t.throws(
      () => store.set(makeKey(), makeValue({ [field]: 'not-a-number' })),
      new RegExp(`expected value\\.${field} to be number`),
      `should throw for bad ${field}`,
    )
  }
  t.end()
})

test('assertCacheValue — throws on non-string statusMessage', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(
    () => store.set(makeKey(), makeValue({ statusMessage: 123 })),
    /expected value.statusMessage to be string/,
  )
  t.end()
})

test('assertCacheValue — throws on non-object headers', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(
    () => store.set(makeKey(), makeValue({ headers: 'bad' })),
    /expected value.rawHeaders to be object/,
  )
  t.end()
})

test('assertCacheValue — throws on non-object vary', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(
    () => store.set(makeKey(), makeValue({ vary: 'bad' })),
    /expected value.vary to be object/,
  )
  t.end()
})

test('assertCacheValue — throws on non-string etag', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(() => store.set(makeKey(), makeValue({ etag: 123 })), /expected value.etag to be string/)
  t.end()
})

// ---------------------------------------------------------------------------
// maxSize / SQLITE_FULL
// ---------------------------------------------------------------------------

test('maxSize: inserts cycle via eviction — set never throws for normal-sized entries', async (t) => {
  const store = new SqliteCacheStore({ maxSize: 4096 * 6 })
  t.teardown(() => store.close())

  const now = Date.now()
  const body = Buffer.alloc(512, 'x')

  t.doesNotThrow(() => {
    for (let i = 0; i < 100; i++) {
      store.set(
        makeKey({ path: `/cycle-${i}` }),
        makeValue({ body, end: body.byteLength, deleteAt: now + 7200e3 + i }),
      )
    }
  })
  await flush()
  t.end()
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('path with query string is part of the key', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/q?a=1' }), makeValue({ statusCode: 200, body: null, end: 0 }))
  store.set(makeKey({ path: '/q?a=2' }), makeValue({ statusCode: 201, body: null, end: 0 }))
  await flush()

  t.equal(store.get(makeKey({ path: '/q?a=1' })).statusCode, 200)
  t.equal(store.get(makeKey({ path: '/q?a=2' })).statusCode, 201)
  t.equal(store.get(makeKey({ path: '/q?a=3' })), undefined)
  t.end()
})

test('body buffer is a proper Buffer (not raw Uint8Array) on result', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey(), makeValue({ body: Buffer.from('data'), end: 4 }))
  await flush()

  const result = store.get(makeKey())
  t.ok(Buffer.isBuffer(result.body), 'body should be a Buffer')
  t.end()
})

test('set with body length mismatch throws assertion error', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  t.throws(() =>
    store.set(makeKey(), makeValue({ body: Buffer.from('hello'), start: 0, end: 99 /* wrong */ })),
  )
  t.end()
})

test('vary with null header in stored entry matches null in request', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/vary-null' }), makeValue({ vary: { 'x-custom': null } }))
  await flush()

  // Request with no x-custom header: headers['x-custom'] is undefined,
  // vary['x-custom'] is null. headerValueEquals(undefined, null) must be true.
  t.ok(store.get(makeKey({ path: '/vary-null' })))
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fixes: assertCacheValue error message, start/end validation, etag ''
// ---------------------------------------------------------------------------

test('assertCacheValue error message reports actual type, not "string"', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  try {
    store.set(makeKey(), 42)
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /number/, 'error says "number"')
    t.notMatch(err.message, /^.*got string/, 'must not say "string"')
  }

  try {
    store.set(makeKey(), 'bad')
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /string/, 'error says "string" for actual string input')
  }

  try {
    store.set(makeKey(), null)
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /null/, 'error says "null"')
  }

  t.end()
})

// ---------------------------------------------------------------------------
// set() — start/end: TypeError for wrong type, RangeError for out-of-range
// ---------------------------------------------------------------------------

test('set throws TypeError when value.start is not a number', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  try {
    store.set(makeKey(), makeValue({ start: 'hello', end: 5 }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof TypeError, 'string start → TypeError')
    t.match(err.message, /expected value\.start/)
  }

  try {
    store.set(makeKey(), makeValue({ start: null, end: 5 }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof TypeError, 'null start → TypeError')
    t.match(err.message, /expected value\.start/)
  }

  t.end()
})

test('set throws RangeError when value.start is negative or non-finite', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  try {
    store.set(makeKey(), makeValue({ start: -1, end: 5, body: Buffer.from('hello') }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof RangeError, 'negative start → RangeError')
    t.match(err.message, /expected value\.start/)
  }

  try {
    store.set(makeKey(), makeValue({ start: Infinity, end: 5 }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof RangeError, 'Infinity start → RangeError')
    t.match(err.message, /expected value\.start/)
  }

  try {
    store.set(makeKey(), makeValue({ start: NaN, end: 5 }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof RangeError, 'NaN start → RangeError')
    t.match(err.message, /expected value\.start/)
  }

  t.end()
})

test('set throws TypeError when value.end is not a number', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  try {
    store.set(makeKey(), makeValue({ start: 0, end: 'five', body: null }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof TypeError, 'string end → TypeError')
    t.match(err.message, /expected value\.end/)
  }

  try {
    store.set(makeKey(), makeValue({ start: 0, end: null, body: null }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof TypeError, 'null end → TypeError')
    t.match(err.message, /expected value\.end/)
  }

  t.end()
})

test('set throws RangeError when value.end < value.start or non-finite', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  try {
    store.set(makeKey(), makeValue({ start: 10, end: 5, body: null }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof RangeError, 'end < start → RangeError')
    t.match(err.message, /expected value\.end/)
  }

  try {
    store.set(makeKey(), makeValue({ start: 0, end: Infinity, body: null }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof RangeError, 'Infinity end → RangeError')
    t.match(err.message, /expected value\.end/)
  }

  try {
    store.set(makeKey(), makeValue({ start: 0, end: NaN, body: null }))
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof RangeError, 'NaN end → RangeError')
    t.match(err.message, /expected value\.end/)
  }

  t.end()
})

test('etag empty string is stored and retrieved as empty string, not undefined', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/etag-empty' }), makeValue({ etag: '' }))
  await flush()
  const result = store.get(makeKey({ path: '/etag-empty' }))
  t.ok(result)
  t.equal(result.etag, '', 'empty etag must round-trip as empty string, not undefined')
  t.end()
})

test('purgeStale on closed store does not throw', (t) => {
  const store = new SqliteCacheStore()
  store.close()

  t.doesNotThrow(() => store.purgeStale(), 'purgeStale must not throw after close')
  t.end()
})
