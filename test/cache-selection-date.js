import { test } from 'tap'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-selection-date-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'cache.sqlite')
}

test('store chooses the most recent matching response by Date, not write order', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  const key = {
    origin: 'https://example.com',
    method: 'GET',
    path: '/resource',
    headers: { accept: 'text/plain' },
  }
  const now = Date.now()
  const value = (body, date, vary) => ({
    body: Buffer.from(body),
    start: 0,
    end: body.length,
    statusCode: 200,
    statusMessage: 'OK',
    headers: { date },
    cacheControlDirectives: { 'max-age': 3600 },
    vary,
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  })

  // Both entries match `Accept: text/plain`. The less-specific response was
  // generated later, but the older Vary-specific response arrived last.
  store.set(key, value('newer', new Date(now).toUTCString(), {}))
  await flush()
  store.set(key, value('older', new Date(now - 60e3).toUTCString(), { accept: 'text/plain' }))
  await flush()

  const result = store.get(key)
  t.equal(result.body.toString(), 'newer', 'RFC 9111 §4 Date ordering wins')

  // Pending entries participate in the same selection before their batch is
  // flushed; being the latest write must not let an older Date jump the queue.
  store.set(key, value('oldest', new Date(now - 120e3).toUTCString(), { 'accept-language': null }))
  t.equal(store.get(key).body.toString(), 'newer', 'Date ordering also covers pending writes')
  await flush()
  t.equal(store.get(key).body.toString(), 'newer', 'ordering is stable after the batch flush')
})

test('duplicate case-insensitive Date fields fall back to receipt time', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  const key = {
    origin: 'https://example.com',
    method: 'GET',
    path: '/duplicate-date',
    headers: { accept: 'text/plain' },
  }
  const now = Date.now()
  const value = (body, headers, vary) => ({
    body: Buffer.from(body),
    start: 0,
    end: body.length,
    statusCode: 200,
    statusMessage: 'OK',
    headers,
    cacheControlDirectives: { 'max-age': 3600 },
    vary,
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
  })

  store.set(key, value('dated', { date: new Date(now - 60e3).toUTCString() }, {}))
  await flush()
  store.set(
    key,
    value(
      'ambiguous',
      {
        Date: new Date(now - 120e3).toUTCString(),
        date: new Date(now - 180e3).toUTCString(),
      },
      { accept: 'text/plain' },
    ),
  )

  t.equal(
    store.get(key).body.toString(),
    'ambiguous',
    'ambiguous Date metadata uses the newer receipt time while pending',
  )
  await flush()
  t.equal(
    store.get(key).body.toString(),
    'ambiguous',
    'the receipt-time fallback survives persistence',
  )
})

test('pending replacements immediately supersede their persisted representation', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  const key = {
    origin: 'https://example.com',
    method: 'GET',
    path: '/pending',
    headers: {},
  }
  const now = Date.now()
  const value = (body, date, deleteAt = now + 7200e3) => ({
    body: Buffer.from(body),
    start: 0,
    end: body.length,
    statusCode: 200,
    statusMessage: 'OK',
    headers: { date },
    cacheControlDirectives: { 'max-age': 3600 },
    vary: {},
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt,
  })

  store.set(key, value('persisted-newer-date', new Date(now).toUTCString()))
  await flush()

  // set() replaces this same stored representation. Its older Date must not
  // resurrect the persisted row during the short pending-batch interval;
  // after the flush only the replacement will exist.
  store.set(key, value('pending-older-date', new Date(now - 60e3).toUTCString()))
  t.equal(store.get(key).body.toString(), 'pending-older-date', 'pending replacement wins now')
  await flush()
  t.equal(store.get(key).body.toString(), 'pending-older-date', 'answer is stable after flush')

  // An expired replacement is a variant-scoped tombstone. It must hide the
  // persisted row immediately even when its response Date sorts earlier.
  store.set(key, value('tombstone', new Date(now - 120e3).toUTCString(), now - 60e3))
  t.equal(store.get(key), undefined, 'pending tombstone shadows the persisted row')
})

test('many pending identities suppress only their exact persisted representations', (t) => {
  const location = tempDb(t)
  const key = {
    origin: 'https://example.com',
    method: 'GET',
    path: '/many-pending',
    headers: {},
  }
  const now = Date.now()
  const value = (body, date, vary, deleteAt = now + 7200e3) => ({
    body: Buffer.from(body),
    start: 0,
    end: body.length,
    statusCode: 200,
    statusMessage: 'OK',
    headers: { date },
    cacheControlDirectives: { 'max-age': 3600 },
    vary,
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt,
  })

  let store = new SqliteCacheStore({ location })
  t.teardown(() => store.close())
  for (let i = 0; i < 64; i++) {
    store.set(key, value(`persisted-${i}`, new Date(now).toUTCString(), { [`x-${i}`]: null }))
  }
  // This neighboring selector overlaps requests carrying x-63 but is not the
  // same stored representation as { x-63: null }.
  store.set(
    key,
    value('distinct-neighbor', new Date(now + 60e3).toUTCString(), {
      'x-63': 'present',
      extra: null,
    }),
  )
  store.close()

  store = new SqliteCacheStore({ location })
  for (let i = 0; i < 64; i++) {
    store.set(
      key,
      value(
        `pending-${i}`,
        new Date(now - 60e3).toUTCString(),
        { [`x-${i}`]: null },
        i === 63 ? now - 60e3 : undefined,
      ),
    )
  }

  t.equal(
    store.get(key).body.toString(),
    'pending-62',
    'exact replacements hide newer persisted rows and the final tombstone is not served',
  )
  t.equal(
    store.get({ ...key, headers: { 'x-63': 'present' } }).body.toString(),
    'distinct-neighbor',
    'a neighboring serialized Vary selector is not over-suppressed',
  )
  t.end()
})
