import { test } from 'tap'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

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
