import { test } from 'tap'
import { SqliteCacheStore, cache } from '../lib/index.js'

test('SqliteCacheStore is exported as a named export', (t) => {
  t.equal(typeof SqliteCacheStore, 'function')
  t.end()
})

test('named export matches cache.SqliteCacheStore', (t) => {
  t.equal(SqliteCacheStore, cache.SqliteCacheStore)
  t.end()
})
