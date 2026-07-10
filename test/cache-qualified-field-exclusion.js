import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

function rawRequest(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    const chunks = []
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc) {
        statusCode = sc
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.from(chunk))
        return true
      },
      onComplete() {
        resolve({ statusCode, body: Buffer.concat(chunks).toString() })
      },
      onError: reject,
    })
  })
}

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

for (const directive of ['private="etag"']) {
  test(`qualified ${directive} excludes ETag from stored validator metadata`, async (t) => {
    const server = await startServer((req, res) => {
      res.writeHead(200, {
        'cache-control': `max-age=60, ${directive}`,
        etag: '"secret"',
      })
      res.end('body')
    })
    t.teardown(() => server.close())

    const store = new SqliteCacheStore({ location: ':memory:' })
    t.teardown(() => store.close())
    const dispatch = compose(new undici.Agent(), interceptors.cache())
    const origin = `http://0.0.0.0:${server.address().port}`
    const base = { origin, path: '/', method: 'GET', cache: { store } }

    await rawRequest(dispatch, { ...base, headers: {} })
    await flush()

    const entry = store.get({ ...base, headers: {} })
    t.equal(entry.headers.etag, undefined, 'ETag response field is excluded')
    t.equal(entry.etag, '', 'the separate validator copy is excluded too')

    const conditional = await rawRequest(dispatch, {
      ...base,
      headers: { 'if-none-match': '"secret"' },
    })
    t.equal(conditional.statusCode, 200, 'cache cannot synthesize a 304 from the excluded ETag')
  })
}

for (const directive of ['private="etag"']) {
  test(`a 304 adding qualified ${directive} clears the stored validator`, async (t) => {
    let hits = 0
    const server = await startServer((req, res) => {
      hits++
      if (hits === 1) {
        res.writeHead(304, { 'cache-control': `max-age=60, ${directive}` })
        res.end()
      } else {
        res.writeHead(200, { 'cache-control': 'no-store' })
        res.end('current')
      }
    })
    t.teardown(() => server.close())

    const store = new SqliteCacheStore({ location: ':memory:' })
    t.teardown(() => store.close())
    const dispatch = compose(new undici.Agent(), interceptors.cache())
    const origin = `http://0.0.0.0:${server.address().port}`
    const key = { origin, path: '/', method: 'GET', headers: {} }
    const now = Date.now()
    store.set(key, {
      body: Buffer.from('stored'),
      start: 0,
      end: 6,
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'cache-control': 'max-age=0', etag: '"secret"' },
      cacheControlDirectives: { 'max-age': 0 },
      etag: '"secret"',
      vary: {},
      cachedAt: now - 1000,
      staleAt: now - 1000,
      deleteAt: now + 60_000,
    })
    await flush()

    const validated = await rawRequest(dispatch, { ...key, cache: { store } })
    t.equal(validated.body, 'stored')
    await flush()

    const entry = store.get(key)
    t.equal(entry.headers.etag, undefined, '304 update removes the ETag response field')
    t.equal(entry.etag, '', '304 update also clears the separate validator copy')

    const conditional = await rawRequest(dispatch, {
      ...key,
      headers: { 'if-none-match': '"secret"' },
      cache: { store },
    })
    t.equal(conditional.statusCode, 200, 'excluded old ETag cannot produce a later cached 304')
  })
}
