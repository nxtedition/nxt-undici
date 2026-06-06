/* eslint-disable */
// Regression tests for SqliteCacheStore bugs found during the in-depth review.
import { test } from 'tap'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
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

function tmpDb(prefix) {
  const dbPath = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
  )
  return dbPath
}

// ---------------------------------------------------------------------------
// 206 partial (start=0) must not be served to a non-range request.
// The SQL `start <= 0` filter does not exclude a start=0 partial, so a plain
// GET would otherwise receive a 206 with only the partial bytes.
// ---------------------------------------------------------------------------

test('non-range request does not return a partial (start=0) 206 entry', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(
    makeKey({ path: '/partial0' }),
    makeValue({
      body: Buffer.from('hello'),
      start: 0,
      end: 5,
      statusCode: 206,
      statusMessage: 'Partial Content',
    }),
  )
  await flush()

  t.equal(
    store.get(makeKey({ path: '/partial0' })),
    undefined,
    'a plain GET must not be served the cached 206 partial',
  )

  // ...but a matching range request still gets it.
  const ranged = store.get(makeKey({ path: '/partial0', headers: { range: 'bytes=0-4' } }))
  t.ok(ranged, 'a matching range request is still served the 206')
  t.equal(ranged.statusCode, 206)
  t.end()
})

// ---------------------------------------------------------------------------
// Vary selecting-header sentinel: a header absent at store time must NOT act
// as a wildcard that matches a later request which supplies the header.
// ---------------------------------------------------------------------------

test('vary: header absent at store time must miss when a later request supplies it', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  // accept was absent in the original request → recorded as the null sentinel.
  store.set(makeKey({ path: '/vary-absent' }), makeValue({ vary: { accept: null } }))
  await flush()

  t.ok(
    store.get(makeKey({ path: '/vary-absent' })),
    'a request that also omits accept hits (both absent)',
  )
  t.equal(
    store.get(makeKey({ path: '/vary-absent', headers: { accept: 'application/json' } })),
    undefined,
    'a request supplying accept must miss (absent-vs-present is a mismatch)',
  )
  t.end()
})

// ---------------------------------------------------------------------------
// close() must drain the ENTIRE batch synchronously, even when it exceeds one
// flush time-budget slice (previously the remainder was discarded).
// ---------------------------------------------------------------------------

test('close() persists a large batch that exceeds one flush time slice', (t) => {
  const dbPath = tmpDb('cache-close-large')
  t.teardown(() => {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + ext)
      } catch {}
    }
  })

  // Large enough to span more than one ~10ms flush time-slice (the buggy
  // close() persisted only the first slice and discarded the rest). Kept
  // modest, and verification is sampled, so the test doesn't hog the event
  // loop and destabilise the parallel suite.
  const N = 12000
  const store = new SqliteCacheStore({ location: dbPath })
  const now = Date.now()
  for (let i = 0; i < N; i++) {
    store.set(
      makeKey({ path: `/big-${i}` }),
      makeValue({ body: Buffer.from('hello'), end: 5, cachedAt: now }),
    )
  }
  // No await — close() must flush the whole batch synchronously.
  store.close()

  const store2 = new SqliteCacheStore({ location: dbPath })
  t.teardown(() => store2.close())

  // Sample across the range — crucially including the LAST entry, which the
  // buggy close() (single budgeted slice) would have dropped.
  const sample = [0, 1, (N / 2) | 0, N - 100, N - 2, N - 1]
  for (const i of sample) {
    t.ok(store2.get(makeKey({ path: `/big-${i}` })), `entry ${i} survived close()`)
  }
  t.end()
})

// ---------------------------------------------------------------------------
// gc() on a closed store must be a clean no-op (no ERR_INVALID_STATE warnings).
// ---------------------------------------------------------------------------

test('gc() on a closed store is a silent no-op', async (t) => {
  const store = new SqliteCacheStore()
  store.close()

  const warnings = []
  const onWarning = (w) => warnings.push(w)
  process.on('warning', onWarning)

  t.doesNotThrow(() => store.gc(), 'gc must not throw after close')

  // process.emitWarning is delivered on nextTick.
  await new Promise((resolve) => setImmediate(resolve))
  process.off('warning', onWarning)

  const dbWarnings = warnings.filter((w) =>
    /not open|INVALID_STATE/.test(`${w?.message} ${w?.code}`),
  )
  t.equal(dbWarnings.length, 0, 'gc on a closed store must not emit database warnings')
  t.end()
})

// ---------------------------------------------------------------------------
// makeResult must return a body that does not alias the in-flight batch entry.
// ---------------------------------------------------------------------------

test('served body is a copy and cannot corrupt the cached entry', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey({ path: '/copy' }), makeValue({ body: Buffer.from('hello'), end: 5 }))

  // Read-through the in-flight batch (before flush) and mutate the result.
  const r1 = store.get(makeKey({ path: '/copy' }))
  r1.body[0] = 0x58 // 'X'

  const r2 = store.get(makeKey({ path: '/copy' }))
  t.equal(r2.body.toString(), 'hello', 'mutating a served body must not corrupt the cached entry')

  await flush()
  const r3 = store.get(makeKey({ path: '/copy' }))
  t.equal(r3.body.toString(), 'hello', 'the flushed DB entry is also intact')
  t.end()
})

// ---------------------------------------------------------------------------
// cachedAt tie-break: when two writes share the same millisecond, the freshest
// (last written) entry must win — in the batch and after flushing to the DB.
// ---------------------------------------------------------------------------

test('tie-break: freshest entry wins when cachedAt is identical (batch)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    makeKey({ path: '/tie-batch' }),
    makeValue({ body: Buffer.from('old'), end: 3, cachedAt: now, deleteAt: now + 1000 }),
  )
  store.set(
    makeKey({ path: '/tie-batch' }),
    makeValue({ body: Buffer.from('new'), end: 3, cachedAt: now, deleteAt: now + 999999 }),
  )

  const r = store.get(makeKey({ path: '/tie-batch' }))
  t.equal(r.body.toString(), 'new', 'the most recently written entry wins the tie (batch path)')
  t.end()
})

test('tie-break: freshest entry wins when cachedAt is identical (DB)', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  const now = Date.now()
  store.set(
    makeKey({ path: '/tie-db' }),
    makeValue({ body: Buffer.from('old'), end: 3, cachedAt: now, deleteAt: now + 1000 }),
  )
  store.set(
    makeKey({ path: '/tie-db' }),
    makeValue({ body: Buffer.from('new'), end: 3, cachedAt: now, deleteAt: now + 999999 }),
  )
  await flush()

  const r = store.get(makeKey({ path: '/tie-db' }))
  t.equal(r.body.toString(), 'new', 'the higher-id row wins the tie (DB path)')
  t.end()
})
