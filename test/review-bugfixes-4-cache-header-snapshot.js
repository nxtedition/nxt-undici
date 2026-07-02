/* eslint-disable */
// Regression test: CacheHandler.onHeaders used to store the response headers
// object BY REFERENCE — the very same object delivered downstream to the
// caller (request() resolves with { statusCode, headers, body } before the
// body finishes). The entry is only serialized to the store at onComplete, so
// any mutation the caller made to res.headers while the body streamed was
// persisted into the shared cache and replayed to every later request —
// in-process cache poisoning across callers sharing a store.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, interceptors, compose, cache as cacheModule } from '../lib/index.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.cache())
}

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

test('cache: caller mutation of res.headers during body streaming does not poison the cache', async (t) => {
  t.plan(7)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60', 'content-type': 'text/plain' })
    // Stream the body in chunks over ~100ms so the caller holds the headers
    // (and can mutate them) well before onComplete serializes the entry.
    const chunks = ['hello', ' ', 'world']
    let i = 0
    const timer = setInterval(() => {
      if (i < chunks.length) {
        res.write(chunks[i++])
      } else {
        clearInterval(timer)
        res.end()
      }
    }, 30)
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatcher = makeDispatch()
  const origin = `http://0.0.0.0:${server.address().port}`

  // First request: mutate the delivered headers BEFORE consuming the body.
  const res1 = await request(origin, { dispatcher, cache: { store } })
  res1.headers['x-injected'] = 'boom'
  delete res1.headers['cache-control']
  let body1 = ''
  for await (const chunk of res1.body) {
    body1 += chunk
  }
  t.equal(body1, 'hello world', 'first response body delivered')
  t.equal(hits, 1, 'first request hits the origin')

  // Second request: must be served from cache, with the ORIGINAL headers —
  // no injected key, cache-control intact.
  const res2 = await request(origin, { dispatcher, cache: { store } })
  let body2 = ''
  for await (const chunk of res2.body) {
    body2 += chunk
  }
  t.equal(hits, 1, 'second request is served from cache')
  t.equal(body2, 'hello world', 'cached body matches')
  t.equal(res2.headers['x-injected'], undefined, 'injected header is not replayed from cache')
  t.equal(res2.headers['cache-control'], 's-maxage=60', 'deleted cache-control is preserved')
  t.equal(res2.headers['content-type'], 'text/plain', 'original headers are intact')
})
