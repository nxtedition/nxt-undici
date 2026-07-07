import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, Agent, SqliteCacheStore } from '../lib/index.js'

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

// Explicit dispatcher: under tap the global dispatcher may have been replaced
// by Node's built-in undici (fetch shares the globalDispatcher symbol), which
// rejects this library's handlers with "invalid onRequestStart method".
function makeDispatcher(t) {
  const dispatcher = new Agent()
  t.teardown(() => dispatcher.close())
  return dispatcher
}

function makeWriter() {
  const docs = []
  return {
    docs,
    write(obj, op) {
      docs.push({ ...obj, op })
    },
  }
}

// ---------------------------------------------------------------------------
// miss then hit: lookup docs at both outcomes + one stored cache-store doc
// ---------------------------------------------------------------------------

test('trace-cache: miss then hit with one stored doc', async (t) => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 'max-age=60' })
    res.end('hello')
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })
  const origin = `http://127.0.0.1:${server.address().port}`
  const dispatcher = makeDispatcher(t)

  for (let n = 0; n < 2; n++) {
    const { body, statusCode } = await request(origin, {
      trace: writer,
      cache: { store },
      dispatcher,
    })
    t.equal(await body.text(), 'hello')
    t.equal(statusCode, 200)
  }
  t.equal(hits, 1, 'second request served from cache')

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 2, 'one lookup doc per dispatch')

  const [miss, hit] = lookups
  t.type(miss.id, 'string')
  t.equal(miss.method, 'GET')
  t.equal(miss.url, `${origin}/`)
  t.equal(miss.result, 'miss')
  t.equal(miss.reason, 'none')
  t.equal(miss.statusCode, null)
  t.equal(miss.ageSec, null)
  t.equal(miss.sizeBytes, null)
  t.type(miss.lookupMs, 'number')
  t.ok(miss.lookupMs >= 0)

  t.type(hit.id, 'string')
  t.not(hit.id, miss.id)
  t.equal(hit.method, 'GET')
  t.equal(hit.url, `${origin}/`)
  t.equal(hit.result, 'hit')
  t.equal(hit.reason, null)
  t.equal(hit.statusCode, 200)
  t.type(hit.ageSec, 'number')
  t.ok(hit.ageSec >= 0)
  t.equal(hit.sizeBytes, 5)
  t.type(hit.lookupMs, 'number')
  t.ok(hit.lookupMs >= 0)

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1, 'only the origin response emits a cache-store doc')

  const [stored] = stores
  t.equal(stored.id, miss.id)
  t.equal(stored.method, 'GET')
  t.equal(stored.url, `${origin}/`)
  t.equal(stored.statusCode, 200)
  t.equal(stored.stored, true)
  t.equal(stored.reason, null)
  t.equal(stored.sizeBytes, 5)
  t.equal(stored.ttlSec, 60)
  t.equal(stored.err, null)
})

// ---------------------------------------------------------------------------
// non-storable origin response → cache-store skipped with the failed gate
// ---------------------------------------------------------------------------

test('trace-cache: no-store response emits skipped cache-store doc', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 'no-store' })
    res.end('nope')
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })
  const origin = `http://127.0.0.1:${server.address().port}`

  const { body, statusCode } = await request(origin, {
    trace: writer,
    cache: { store },
    dispatcher: makeDispatcher(t),
  })
  t.equal(await body.text(), 'nope')
  t.equal(statusCode, 200)

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:cache')
  t.equal(lookups.length, 1)
  t.equal(lookups[0].result, 'miss')
  t.equal(lookups[0].reason, 'none')

  const stores = writer.docs.filter((doc) => doc.op === 'undici:cache-store')
  t.equal(stores.length, 1)

  const [skipped] = stores
  t.equal(skipped.id, lookups[0].id)
  t.equal(skipped.method, 'GET')
  t.equal(skipped.url, `${origin}/`)
  t.equal(skipped.statusCode, 200)
  t.equal(skipped.stored, false)
  t.equal(skipped.reason, 'no-store')
  t.equal(skipped.sizeBytes, null)
  t.equal(skipped.ttlSec, null)
  t.equal(skipped.err, null)
})

// ---------------------------------------------------------------------------
// unsafe method against a cached URL → cache-invalidate doc
// ---------------------------------------------------------------------------

test('trace-cache: POST to a cached URL emits cache-invalidate doc', async (t) => {
  const server = await startServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'cache-control': 'max-age=60' })
      res.end('hello')
    } else {
      req.resume()
      res.end('ok')
    }
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const store = new SqliteCacheStore({ location: ':memory:' })
  const origin = `http://127.0.0.1:${server.address().port}`
  const dispatcher = makeDispatcher(t)

  // Populate the cache, then invalidate it with an unsafe method.
  const get = await request(origin, { trace: writer, cache: { store }, dispatcher })
  t.equal(await get.body.text(), 'hello')

  const post = await request(origin, {
    method: 'POST',
    body: 'x',
    trace: writer,
    cache: { store },
    dispatcher,
  })
  t.equal(await post.body.text(), 'ok')
  t.equal(post.statusCode, 200)

  const invalidations = writer.docs.filter((doc) => doc.op === 'undici:cache-invalidate')
  t.equal(invalidations.length, 1)

  const [invalidated] = invalidations
  t.type(invalidated.id, 'string')
  t.equal(invalidated.method, 'POST')
  t.equal(invalidated.url, `${origin}/`)
  t.equal(invalidated.statusCode, 200)
  t.ok(invalidated.paths >= 1)
  t.equal(invalidated.err, null)
})
