// Regression tests for request() URL normalization: URLObject marks every
// field optional, so request({ origin }) without a path must default the
// path to '/' instead of undici rejecting with "path must be a string".
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request } from '../lib/index.js'

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

test('request({ origin }) without a path defaults to /', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    t.equal(req.url, '/', 'server sees /')
    res.end('ok')
  })
  t.teardown(() => server.close())

  const { statusCode, body } = await request({
    origin: `http://127.0.0.1:${server.address().port}`,
  })
  await body.dump()
  t.equal(statusCode, 200)
})

test('request(url, opts) with origin-only URLObject defaults to /', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    t.equal(req.url, '/', 'server sees /')
    res.end('ok')
  })
  t.teardown(() => server.close())

  const { statusCode, body } = await request(
    { origin: `http://127.0.0.1:${server.address().port}` },
    { method: 'GET' },
  )
  await body.dump()
  t.equal(statusCode, 200)
})

test('request({ origin, search }) without pathname keeps the query on /', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    t.equal(req.url, '/?a=1', 'server sees /?a=1')
    res.end('ok')
  })
  t.teardown(() => server.close())

  const { statusCode, body } = await request({
    origin: `http://127.0.0.1:${server.address().port}`,
    search: '?a=1',
  })
  await body.dump()
  t.equal(statusCode, 200)
})

test('request({ origin, pathname }) still honors an explicit pathname', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    t.equal(req.url, '/explicit', 'server sees /explicit')
    res.end('ok')
  })
  t.teardown(() => server.close())

  const { statusCode, body } = await request({
    origin: `http://127.0.0.1:${server.address().port}`,
    pathname: '/explicit',
  })
  await body.dump()
  t.equal(statusCode, 200)
})
