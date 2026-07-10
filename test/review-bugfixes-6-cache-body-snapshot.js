import { test } from 'tap'
import { interceptors, cache as cacheModule } from '../lib/index.js'

const { SqliteCacheStore } = cacheModule

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('cache: caller mutation of an origin body chunk does not poison the stored body', async (t) => {
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  let originHits = 0
  const originChunk = Buffer.from('hello')
  const dispatch = interceptors.cache()((_opts, handler) => {
    originHits++
    handler.onConnect(() => {})
    handler.onHeaders(200, { 'cache-control': 'max-age=60' }, () => {})
    handler.onData(originChunk)
    handler.onComplete(null)
    return true
  })

  const request = (mutate) =>
    new Promise((resolve, reject) => {
      const chunks = []
      dispatch(
        {
          origin: 'http://cache-body-snapshot.local',
          path: '/',
          method: 'GET',
          headers: {},
          cache: { store },
        },
        {
          onConnect() {},
          onHeaders() {},
          onData(chunk) {
            chunks.push(Buffer.from(chunk))
            if (mutate) {
              chunk[0] = 0x58 // X
            }
          },
          onComplete() {
            resolve(Buffer.concat(chunks).toString())
          },
          onError: reject,
        },
      )
    })

  t.equal(await request(true), 'hello', 'the first caller receives the origin bytes')
  await flush()

  t.equal(await request(false), 'hello', 'the cached body retains the original bytes')
  t.equal(originHits, 1, 'the second request was served from cache')
})
