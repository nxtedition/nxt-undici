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
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Basic get / set round-trip
// ---------------------------------------------------------------------------

test('basic get/set round-trip', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const key = makeKey()
  const now = Date.now()
  const value = makeValue({
    body: Buffer.from('hello world'),
    end: 11,
    headers: { 'content-type': 'text/plain' },
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  })

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

  t.equal(store.get(makeKey({ path: '/missing' })), undefined)
  t.end()
})

test('get returns undefined for expired entry', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const past = Date.now() - 10000
  store.set(
    makeKey({ path: '/expired' }),
    makeValue({ deleteAt: past, staleAt: past - 1, cachedAt: past - 2 }),
  )
  t.equal(store.get(makeKey({ path: '/expired' })), undefined)
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fix: expired entry must not block valid entries in the same result set
// ---------------------------------------------------------------------------

test('expired entry does not block valid entry with later deleteAt (bug fix)', (t) => {
  // This test would have returned undefined with the old code because the
  // first row (ordered by deleteAt ASC) was expired, and the loop did
  // `return undefined` instead of `continue`.
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const past = now - 10000

  // Insert two entries for the same URL/method.
  // Entry 1: already expired, vary = gzip
  store.set(
    makeKey({ path: '/overlap', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({
      path: '/overlap',
      vary: { 'accept-encoding': 'gzip' },
      deleteAt: past,
      staleAt: past - 1,
      cachedAt: past - 2,
    }),
  )

  // Entry 2: valid, vary = deflate (different — should still be found)
  store.set(
    makeKey({ path: '/overlap', headers: { 'accept-encoding': 'deflate' } }),
    makeValue({
      body: Buffer.from('deflate-body'),
      end: 12,
      vary: { 'accept-encoding': 'deflate' },
      cachedAt: now,
      staleAt: now + 3600e3,
      deleteAt: now + 7200e3,
    }),
  )

  // The expired entry comes first in ORDER BY deleteAt ASC.
  // get() with deflate must skip the expired row and find the valid one.
  const result = store.get(makeKey({ path: '/overlap', headers: { 'accept-encoding': 'deflate' } }))
  t.ok(result, 'should find the valid entry despite the expired entry coming first')
  t.equal(result.body.toString(), 'deflate-body')
  t.end()
})

test('expired entry with matching vary must not be returned (bug fix)', (t) => {
  // The old code would have caught the expiry via `return undefined` which was
  // coincidentally correct for this shape, but we verify the SQL filter works.
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const past = Date.now() - 10000
  store.set(
    makeKey({ headers: { 'accept-encoding': 'gzip' } }),
    makeValue({
      vary: { 'accept-encoding': 'gzip' },
      deleteAt: past,
      staleAt: past - 1,
      cachedAt: past - 2,
    }),
  )

  t.equal(store.get(makeKey({ headers: { 'accept-encoding': 'gzip' } })), undefined)
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fix: makeValueUrl — no double slash when path starts with "/"
// ---------------------------------------------------------------------------

test('path starting with / is stored and looked up correctly (no double-slash key)', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  // Insert with a path that has a leading slash (the common case).
  store.set(makeKey({ path: '/foo/bar' }), makeValue())

  // Must find the entry — if there was a key mismatch (double slash on write,
  // single slash on read, or vice versa) this would return undefined.
  const result = store.get(makeKey({ path: '/foo/bar' }))
  t.ok(result)

  // A different path must NOT collide.
  t.equal(store.get(makeKey({ path: '//foo/bar' })), undefined)
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fix: assertCacheKey error message
// ---------------------------------------------------------------------------

test('assertCacheKey error message contains actual type, not "string"', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  // Passing a number — printType should report "number", not "string".
  try {
    store.get(42)
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /number/, 'error message should say "number"')
    t.notMatch(err.message, /^expected key to be object, got string/, 'must not say "string"')
  }

  // Passing null — printType reports "null".
  try {
    store.get(null)
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /null/)
  }

  t.end()
})

// ---------------------------------------------------------------------------
// SQLITE_FULL handling — evict without debounce
// ---------------------------------------------------------------------------

test('set succeeds immediately after SQLITE_FULL without sleep (evict fix)', (t) => {
  // With the old code this required ~1100ms sleep because #prune was debounced.
  // With #evictQuery there is no debounce; the retry is immediate.
  const store = new SqliteCacheStore({ maxSize: 4096 * 6 })
  t.teardown(() => store.close())

  const past = Date.now() - 120e3
  const largeBody = Buffer.alloc(4096, 'x')

  // Fill with expired entries until SQLITE_FULL.
  let inserted = 0
  try {
    for (let i = 0; i < 100; i++) {
      store.set(
        makeKey({ path: `/expired-${i}` }),
        makeValue({
          body: largeBody,
          end: largeBody.byteLength,
          deleteAt: past,
          staleAt: past - 1,
          cachedAt: past - 2,
        }),
      )
      inserted++
    }
  } catch {
    // Expected — DB is full.
  }

  t.ok(inserted > 0, 'inserted at least some entries before full')

  // Insert immediately (no sleep) — should succeed via evict + retry.
  const now = Date.now()
  store.set(
    makeKey({ path: '/after-evict' }),
    makeValue({
      body: Buffer.from('new'),
      end: 3,
      cachedAt: now,
      staleAt: now + 3600e3,
      deleteAt: now + 7200e3,
    }),
  )

  const result = store.get(makeKey({ path: '/after-evict' }))
  t.ok(result)
  t.equal(result.body.toString(), 'new')
  t.end()
})

test('set never throws on DB errors — emits process warning instead', (t) => {
  // Fill a tiny DB with non-expired entries then verify that even when every
  // insert triggers SQLITE_FULL (eviction frees room or warning is emitted),
  // set() never propagates a DB exception.
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
          staleAt: now + 3600e3,
          deleteAt: now + 7200e3 + i,
        }),
      )
    }
  }, 'set must never throw on any DB error')
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fix: re-cached entry must be returned, not the stale duplicate
// ---------------------------------------------------------------------------

test('re-caching same key returns the freshest entry (cachedAt DESC fix)', (t) => {
  // With ORDER BY deleteAt ASC the old entry came first (it had a shorter TTL
  // from the original cache-control), so get() would return stale data even
  // though a fresh response had just been stored.
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  const key = makeKey({ path: '/revalidated' })

  // First cache: short TTL, body = 'old'
  store.set(
    key,
    makeValue({
      body: Buffer.from('old'),
      end: 3,
      cachedAt: now - 5000,
      staleAt: now - 1000,
      deleteAt: now + 1000, // expires soon — ORDER BY deleteAt ASC picks this first
    }),
  )

  // Re-cache after revalidation: longer TTL, body = 'fresh'
  store.set(
    key,
    makeValue({
      body: Buffer.from('fresh'),
      end: 5,
      cachedAt: now,
      staleAt: now + 3600e3,
      deleteAt: now + 7200e3,
    }),
  )

  const result = store.get(key)
  t.ok(result)
  t.equal(result.body.toString(), 'fresh', 'must return the most recently cached entry')
  t.end()
})

test('set never throws when body is too large to fit even after eviction', (t) => {
  // When a body is larger than the entire DB capacity, the first insert fails
  // (SQLITE_FULL), eviction removes all existing rows, but the retry still fails
  // because the body alone exceeds max_page_count. The error must be emitted as
  // a warning, not propagated. This covers the evict+retry failure path.
  const maxSize = 4096 * 6
  const store = new SqliteCacheStore({ maxSize })
  t.teardown(() => store.close())

  // A body the size of the entire DB — cannot fit even in an empty database.
  const tooBig = Buffer.alloc(maxSize, 'x')
  const now = Date.now()

  t.doesNotThrow(() => {
    store.set(
      makeKey({ path: '/too-big' }),
      makeValue({
        body: tooBig,
        end: tooBig.byteLength,
        cachedAt: now,
        staleAt: now + 3600e3,
        deleteAt: now + 7200e3,
      }),
    )
  }, 'must not throw even when body is too large to ever fit')
  t.end()
})

// ---------------------------------------------------------------------------
// purgeStale — no debounce, always runs
// ---------------------------------------------------------------------------

test('purgeStale always deletes expired entries regardless of call frequency', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const past = Date.now() - 120e3
  const key = makeKey({ path: '/purge-test' })

  store.set(key, makeValue({ deleteAt: past, staleAt: past - 1, cachedAt: past - 2 }))

  // Old code debounced #prune — calling purgeStale immediately after construction
  // would have been a no-op. Call it twice in a row to confirm no debounce.
  store.purgeStale()
  store.purgeStale()

  // Now insert a fresh entry to confirm the old row was removed and not interfering.
  const now = Date.now()
  store.set(
    key,
    makeValue({
      body: Buffer.from('fresh'),
      end: 5,
      cachedAt: now,
      staleAt: now + 3600e3,
      deleteAt: now + 7200e3,
    }),
  )
  const result = store.get(key)
  t.ok(result)
  t.equal(result.body.toString(), 'fresh')
  t.end()
})

// ---------------------------------------------------------------------------
// Vary header matching
// ---------------------------------------------------------------------------

test('vary header matching — hit', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )

  const result = store.get(makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } }))
  t.ok(result)
  t.end()
})

test('vary header matching — miss on different value', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )

  t.equal(store.get(makeKey({ path: '/vary', headers: { 'accept-encoding': 'br' } })), undefined)
  t.end()
})

test('vary header matching — miss when request has no matching header', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/vary', headers: { 'accept-encoding': 'gzip' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip' } }),
  )

  t.equal(store.get(makeKey({ path: '/vary' })), undefined)
  t.end()
})

test('multiple vary variants for the same URL', (t) => {
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

test('vary with array header values — all elements must match', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/vary-arr', headers: { 'accept-encoding': ['gzip', 'br'] } }),
    makeValue({ vary: { 'accept-encoding': ['gzip', 'br'] } }),
  )

  // Exact match
  t.ok(store.get(makeKey({ path: '/vary-arr', headers: { 'accept-encoding': ['gzip', 'br'] } })))
  // Different order — must not match (strict array equality)
  t.equal(
    store.get(makeKey({ path: '/vary-arr', headers: { 'accept-encoding': ['br', 'gzip'] } })),
    undefined,
  )
  // Subset — must not match
  t.equal(
    store.get(makeKey({ path: '/vary-arr', headers: { 'accept-encoding': ['gzip'] } })),
    undefined,
  )
  t.end()
})

test('multi-header vary — all headers must match', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/mv2', headers: { 'accept-encoding': 'gzip', 'accept-language': 'en' } }),
    makeValue({ vary: { 'accept-encoding': 'gzip', 'accept-language': 'en' } }),
  )

  // Both match
  t.ok(
    store.get(
      makeKey({ path: '/mv2', headers: { 'accept-encoding': 'gzip', 'accept-language': 'en' } }),
    ),
  )
  // One wrong
  t.equal(
    store.get(
      makeKey({ path: '/mv2', headers: { 'accept-encoding': 'gzip', 'accept-language': 'fr' } }),
    ),
    undefined,
  )
  // One missing
  t.equal(store.get(makeKey({ path: '/mv2', headers: { 'accept-encoding': 'gzip' } })), undefined)
  t.end()
})

// ---------------------------------------------------------------------------
// Range header handling
// ---------------------------------------------------------------------------

test('range header — array range returns undefined', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey(), makeValue())

  t.equal(store.get(makeKey({ headers: { range: ['bytes=0-1', 'bytes=2-3'] } })), undefined)
  t.end()
})

test('range header — invalid range string returns undefined', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey(), makeValue())

  t.equal(store.get(makeKey({ headers: { range: 'invalid' } })), undefined)
  t.end()
})

test('range header — exact match on both start and end returns entry', (t) => {
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

  const hit = store.get(makeKey({ path: '/range', headers: { range: 'bytes=10-16' } }))
  t.ok(hit)
  t.equal(hit.body.toString(), 'partial')
  t.equal(hit.statusCode, 206)
  t.end()
})

test('range header — start in range but end mismatch → miss (covers loop continue)', (t) => {
  // The SQL query uses `start <= ?` so entries with start=0 appear when requesting
  // bytes=0-49. But the stored end (100) != requested end (50), so the loop must
  // continue and return undefined. This covers the range-mismatch `continue` branch.
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/range-end-mismatch' }),
    makeValue({ body: Buffer.alloc(100, 'x'), start: 0, end: 100, statusCode: 200 }),
  )

  // Same start, different end — must miss.
  t.equal(
    store.get(makeKey({ path: '/range-end-mismatch', headers: { range: 'bytes=0-49' } })),
    undefined,
    'different end must not match',
  )
  t.end()
})

test('range header — requested start differs from stored start → miss (covers loop continue)', (t) => {
  // Store entry at start=5. Range request bytes=0-4 queries start<=0 so the entry
  // doesn't appear in results (filtered by SQL). Range request bytes=5-9 is an exact
  // match. Range request bytes=3-9: query start<=3 → entry NOT returned (start=5 > 3).
  // To actually hit the JS continue: store start=0, request bytes=5-9 (query start<=5
  // returns it, but JS check 5 !== 0 → continue).
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  // Full response stored at start=0.
  store.set(
    makeKey({ path: '/range-start-mismatch' }),
    makeValue({ body: Buffer.alloc(100, 'y'), start: 0, end: 100, statusCode: 200 }),
  )

  // Range request bytes=5-9: query returns the entry (start=0 <= 5), but start mismatch
  // (5 !== 0) → loop continues → undefined.
  t.equal(
    store.get(makeKey({ path: '/range-start-mismatch', headers: { range: 'bytes=5-9' } })),
    undefined,
    'start mismatch must not match',
  )
  t.end()
})

test('range header — request for different byte window than stored → miss', (t) => {
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

  // Requested range does not overlap the stored range at all (SQL filters it out).
  t.equal(store.get(makeKey({ path: '/range', headers: { range: 'bytes=0-5' } })), undefined)
  // Requested range overlaps but isn't exact.
  t.equal(store.get(makeKey({ path: '/range', headers: { range: 'bytes=10-20' } })), undefined)
  t.end()
})

test('range header — open-ended range (bytes=N-) returns undefined', (t) => {
  // Open-ended range parses to { start, end: null }. The stored entry has a
  // concrete end, so end !== null → no match. The store does not support
  // serving open-ended ranges.
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/range-open' }),
    makeValue({ body: Buffer.alloc(100, 'z'), start: 0, end: 100, statusCode: 200 }),
  )

  t.equal(
    store.get(makeKey({ path: '/range-open', headers: { range: 'bytes=0-' } })),
    undefined,
    'open-ended range must not match',
  )
  t.end()
})

test('non-range request does not return a partial (start > 0) cached entry', (t) => {
  // A stored partial entry has start=10. A non-range request queries start <= 0,
  // so the entry must not be returned.
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

  t.equal(store.get(makeKey({ path: '/partial' })), undefined)
  t.end()
})

test('non-range request returns a full cached response (start=0)', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/full-non-range' }),
    makeValue({ body: Buffer.from('full body'), start: 0, end: 9, statusCode: 200 }),
  )

  const result = store.get(makeKey({ path: '/full-non-range' }))
  t.ok(result)
  t.equal(result.body.toString(), 'full body')
  t.end()
})

// ---------------------------------------------------------------------------
// Body variants
// ---------------------------------------------------------------------------

test('set with array body', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/arr' }),
    makeValue({ body: [Buffer.from('hello'), Buffer.from(' world')], end: 11 }),
  )

  t.equal(store.get(makeKey({ path: '/arr' })).body.toString(), 'hello world')
  t.end()
})

test('set with null body', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/null' }),
    makeValue({ body: null, end: 0, statusCode: 204, statusMessage: 'No Content' }),
  )

  const result = store.get(makeKey({ path: '/null' }))
  t.ok(result)
  t.equal(result.statusCode, 204)
  t.equal(result.body, undefined)
  t.end()
})

test('large body round-trip', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const largeBody = Buffer.alloc(1024 * 1024, 'x')
  store.set(makeKey({ path: '/large' }), makeValue({ body: largeBody, end: largeBody.byteLength }))

  const result = store.get(makeKey({ path: '/large' }))
  t.ok(result)
  t.equal(result.body.byteLength, 1024 * 1024)
  t.ok(result.body.equals(largeBody))
  t.end()
})

// ---------------------------------------------------------------------------
// Key distinctness
// ---------------------------------------------------------------------------

test('different methods are distinct keys', (t) => {
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

  t.equal(store.get(makeKey({ method: 'GET', path: '/m' })).statusCode, 200)
  t.equal(store.get(makeKey({ method: 'HEAD', path: '/m' })).statusCode, 204)
  t.end()
})

test('different origins are distinct keys', (t) => {
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

  t.equal(store.get(makeKey({ origin: 'https://a.com', path: '/x' })).statusCode, 200)
  t.equal(store.get(makeKey({ origin: 'https://b.com', path: '/x' })).statusCode, 404)
  t.end()
})

test('different paths are distinct keys', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/a' }), makeValue({ statusCode: 200, body: null, end: 0 }))
  store.set(makeKey({ path: '/b' }), makeValue({ statusCode: 404, body: null, end: 0 }))

  t.equal(store.get(makeKey({ path: '/a' })).statusCode, 200)
  t.equal(store.get(makeKey({ path: '/b' })).statusCode, 404)
  t.end()
})

// ---------------------------------------------------------------------------
// Duplicate inserts and ordering
// ---------------------------------------------------------------------------

test('duplicate set inserts both entries; get returns earliest deleteAt', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    makeKey({ path: '/dup' }),
    makeValue({ body: Buffer.from('first'), end: 5, deleteAt: now + 7200e3 }),
  )
  store.set(
    makeKey({ path: '/dup' }),
    makeValue({ body: Buffer.from('second'), end: 6, deleteAt: now + 7201e3 }),
  )

  const result = store.get(makeKey({ path: '/dup' }))
  t.ok(result)
  t.equal(result.body.toString(), 'first')
  t.end()
})

// ---------------------------------------------------------------------------
// Optional fields round-trip
// ---------------------------------------------------------------------------

test('etag stored and retrieved', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/etag' }), makeValue({ etag: '"abc123"' }))
  t.equal(store.get(makeKey({ path: '/etag' })).etag, '"abc123"')
  t.end()
})

test('cacheControlDirectives stored and retrieved', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/cc' }),
    makeValue({ cacheControlDirectives: { 'max-age': 3600, public: true } }),
  )
  t.strictSame(store.get(makeKey({ path: '/cc' })).cacheControlDirectives, {
    'max-age': 3600,
    public: true,
  })
  t.end()
})

test('cachedAt, staleAt, deleteAt round-trip', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    makeKey({ path: '/ts' }),
    makeValue({ cachedAt: now, staleAt: now + 1800e3, deleteAt: now + 3600e3 }),
  )

  const result = store.get(makeKey({ path: '/ts' }))
  t.equal(result.cachedAt, now)
  t.equal(result.staleAt, now + 1800e3)
  t.equal(result.deleteAt, now + 3600e3)
  t.end()
})

test('result omits undefined optional fields when not set', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/minimal' }), makeValue({ body: Buffer.from('x'), end: 1 }))

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
  store1.close()

  const store2 = new SqliteCacheStore({ location: dbPath })
  t.teardown(() => store2.close())
  const result = store2.get(makeKey({ path: '/persist' }))
  t.ok(result)
  t.equal(result.body.toString(), 'persisted')
  t.end()
})

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

test('close removes store from global set and prevents further use', (t) => {
  const store = new SqliteCacheStore()
  store.set(makeKey(), makeValue())
  store.close()

  // get() is not guarded against DB errors so it throws after close.
  t.throws(() => store.get(makeKey()))
  // set() swallows DB errors as warnings, so it must not throw after close.
  t.doesNotThrow(() => store.set(makeKey(), makeValue()))
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

  for (const field of ['statusCode', 'cachedAt', 'staleAt', 'deleteAt']) {
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

test('maxSize: inserts cycle via eviction — set never throws for normal-sized entries', (t) => {
  // With eviction, the store should always accept new writes by removing the
  // oldest (lowest deleteAt) entries when the DB is full. All 100 inserts
  // must succeed without throwing.
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
  }, 'all inserts should succeed via eviction')
  t.end()
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('path with query string is part of the key', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/q?a=1' }), makeValue({ statusCode: 200, body: null, end: 0 }))
  store.set(makeKey({ path: '/q?a=2' }), makeValue({ statusCode: 201, body: null, end: 0 }))

  t.equal(store.get(makeKey({ path: '/q?a=1' })).statusCode, 200)
  t.equal(store.get(makeKey({ path: '/q?a=2' })).statusCode, 201)
  t.equal(store.get(makeKey({ path: '/q?a=3' })), undefined)
  t.end()
})

test('body buffer is a proper Buffer (not raw Uint8Array) on result', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey(), makeValue({ body: Buffer.from('data'), end: 4 }))

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

test('vary with null header in stored entry matches null in request', (t) => {
  // Tests the headerValueEquals(null, null) === true path.
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/vary-null' }), makeValue({ vary: { 'x-custom': null } }))

  // Request with no x-custom header — headers[x-custom] is undefined, vary[x-custom] is null.
  // Both are nullish so headerValueEquals(undefined, null) must return true.
  const result = store.get(makeKey({ path: '/vary-null' }))
  t.ok(result)
  t.end()
})

// ---------------------------------------------------------------------------
// Bug fixes: assertCacheValue error message, start/end validation, etag ''
// ---------------------------------------------------------------------------

test('assertCacheValue error message reports actual type, not "string"', (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  // Passing a number — error must say "number", not "string".
  try {
    store.set(makeKey(), 42)
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /number/, 'error says "number"')
    t.notMatch(err.message, /^.*got string/, 'must not say "string"')
  }

  // Passing a string — error must say "string".
  try {
    store.set(makeKey(), 'bad')
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /string/, 'error says "string" for actual string input')
  }

  // Passing null — error must say "null".
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

test('etag empty string is stored and retrieved as empty string, not undefined', (t) => {
  // An empty etag '' is a valid (if unusual) string. The old falsy check
  // `value.etag ? ... : null` would have silently discarded it.
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/etag-empty' }), makeValue({ etag: '' }))
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
