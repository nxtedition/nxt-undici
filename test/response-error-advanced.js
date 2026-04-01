/* eslint-disable */
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

// ---------------------------------------------------------------------------
// error: false passes through non-2xx without throwing
// ---------------------------------------------------------------------------

test('response-error: error:false returns 4xx without throwing', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.statusCode = 404
    res.end('not found')
  })
  t.teardown(server.close.bind(server))

  const { statusCode, body } = await request(`http://127.0.0.1:${server.address().port}`, {
    error: false,
    retry: false,
  })
  await body.dump()
  t.equal(statusCode, 404)
})

// ---------------------------------------------------------------------------
// JSON error body is parsed and attached
// ---------------------------------------------------------------------------

test('response-error: JSON body from 4xx is parsed onto err.body', async (t) => {
  t.plan(2)
  const payload = { code: 'INVALID', reason: 'bad input' }
  const server = await startServer((req, res) => {
    const body = JSON.stringify(payload)
    res.writeHead(422, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  t.teardown(server.close.bind(server))

  try {
    await request(`http://127.0.0.1:${server.address().port}`, { retry: false })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.statusCode, 422)
    t.same(err.body, payload)
  }
})

// ---------------------------------------------------------------------------
// reason and code from JSON body are promoted to error
// ---------------------------------------------------------------------------

test('response-error: reason and code promoted from JSON body', async (t) => {
  t.plan(3)
  const payload = { reason: 'rate limited', code: 'RATE_LIMIT' }
  const server = await startServer((req, res) => {
    const body = JSON.stringify(payload)
    res.writeHead(429, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  t.teardown(server.close.bind(server))

  try {
    await request(`http://127.0.0.1:${server.address().port}`, {
      retry: false,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.statusCode, 429)
    t.equal(err.reason, 'rate limited')
    t.equal(err.code, 'RATE_LIMIT')
  }
})

// ---------------------------------------------------------------------------
// Plain-text body is attached as string
// ---------------------------------------------------------------------------

test('response-error: text/plain body attached to err.body', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(400, {
      'content-type': 'text/plain',
      'content-length': '3',
    })
    res.end('bad')
  })
  t.teardown(server.close.bind(server))

  try {
    await request(`http://127.0.0.1:${server.address().port}`, { retry: false })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.statusCode, 400)
    t.equal(err.body, 'bad')
  }
})

// ---------------------------------------------------------------------------
// err.req contains the request details
// ---------------------------------------------------------------------------

test('response-error: err.req contains origin, path, method, headers', async (t) => {
  t.plan(4)
  const server = await startServer((req, res) => {
    res.statusCode = 500
    res.end()
  })
  t.teardown(server.close.bind(server))

  try {
    await request(`http://127.0.0.1:${server.address().port}/some/path`, {
      method: 'GET',
      retry: false,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.req)
    t.ok(err.req.origin.includes('127.0.0.1'))
    t.equal(err.req.path, '/some/path')
    t.equal(err.req.method, 'GET')
  }
})

// ---------------------------------------------------------------------------
// err.res.headers contains the response headers
// ---------------------------------------------------------------------------

test('response-error: err.res.headers contains response headers', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(503, { 'x-custom-header': 'yes', 'content-type': 'text/plain' })
    res.end('unavailable')
  })
  t.teardown(server.close.bind(server))

  try {
    await request(`http://127.0.0.1:${server.address().port}`, { retry: false })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.statusCode, 503)
    t.equal(err.res.headers['x-custom-header'], 'yes')
  }
})

// ---------------------------------------------------------------------------
// Unknown content-type body is not parsed as JSON but can still be attached
// ---------------------------------------------------------------------------

test('response-error: unknown content-type body not attached', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/octet-stream' })
    res.end(Buffer.from([0x01, 0x02, 0x03]))
  })
  t.teardown(server.close.bind(server))

  try {
    await request(`http://127.0.0.1:${server.address().port}`, { retry: false })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.statusCode, 400)
    // Binary body with unknown content-type is not decoded/attached
    t.notOk(err.body)
  }
})
