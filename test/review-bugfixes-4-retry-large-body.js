import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request } from '../lib/index.js'

// Exceeds the 256 KiB cap on how much of a >= 400 body response-retry
// buffers for replay.
const BODY_SIZE = 300 * 1024
const LARGE_BODY = 'x'.repeat(BODY_SIZE)

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

// ---------------------------------------------------------------------------
// Bug fix: for retry-eligible methods, response-retry buffered >= 400 bodies
// so it could replay them if no retry happened, but discarded the ENTIRE
// buffer once it grew past 256 KiB. When the retry decision was "no", it then
// replayed the headers (still advertising the full content-length) followed
// by zero body bytes — silent data loss, or a bogus "Response body size
// mismatch" error from response-verify that masked the real HTTP error.
// ---------------------------------------------------------------------------

test('retry: large 4xx body with content-length is delivered in full', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(400, {
      'content-type': 'text/plain',
      'content-length': String(BODY_SIZE),
    })
    res.end(LARGE_BODY)
  })
  t.teardown(server.close.bind(server))

  const { statusCode, body } = await request(`http://127.0.0.1:${server.address().port}`, {
    error: false,
    verify: false,
  })
  const text = await body.text()
  t.equal(statusCode, 400)
  t.equal(text.length, BODY_SIZE, 'body must not be truncated to zero bytes')
})

test('retry: large chunked 4xx body is flushed through once the cap is exceeded', async (t) => {
  t.plan(2)
  const chunkSize = 60 * 1024
  const server = await startServer((req, res) => {
    // No content-length — chunked transfer-encoding. The cap is only
    // exceeded mid-stream, exercising the onData flush path.
    res.statusCode = 400
    res.setHeader('content-type', 'text/plain')
    for (let pos = 0; pos < BODY_SIZE; pos += chunkSize) {
      res.write(LARGE_BODY.slice(pos, pos + chunkSize))
    }
    res.end()
  })
  t.teardown(server.close.bind(server))

  const { statusCode, body } = await request(`http://127.0.0.1:${server.address().port}`, {
    error: false,
    verify: false,
  })
  const text = await body.text()
  t.equal(statusCode, 400)
  t.equal(text.length, BODY_SIZE, 'all buffered and subsequent chunks must be delivered')
})

test('retry: large 4xx body with default options rejects with the HTTP error', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(400, {
      'content-type': 'text/plain',
      'content-length': String(BODY_SIZE),
    })
    res.end(LARGE_BODY)
  })
  t.teardown(server.close.bind(server))

  try {
    await request(`http://127.0.0.1:${server.address().port}`)
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.statusCode, 400, 'the real HTTP error must surface')
    t.not(err.message, 'Response body size mismatch', 'must not be masked by response-verify')
  }
})

test('retry: large 5xx body is passed through instead of retried', async (t) => {
  t.plan(3)
  let attempts = 0
  const server = await startServer((req, res) => {
    attempts++
    res.writeHead(503, {
      'content-type': 'text/plain',
      'content-length': String(BODY_SIZE),
    })
    res.end(LARGE_BODY)
  })
  t.teardown(server.close.bind(server))

  const { statusCode, body } = await request(`http://127.0.0.1:${server.address().port}`, {
    error: false,
    verify: false,
  })
  const text = await body.text()
  t.equal(statusCode, 503)
  t.equal(text.length, BODY_SIZE)
  t.equal(attempts, 1, 'a body too large to replay is not status-code retried')
})

// ---------------------------------------------------------------------------
// Guard against regressions in the small-body paths.
// ---------------------------------------------------------------------------

test('retry: small 4xx error body is still buffered and replayed', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(404, {
      'content-type': 'text/plain',
      'content-length': '9',
    })
    res.end('not found')
  })
  t.teardown(server.close.bind(server))

  const { statusCode, body } = await request(`http://127.0.0.1:${server.address().port}`, {
    error: false,
  })
  t.equal(statusCode, 404)
  t.equal(await body.text(), 'not found')
})

test('retry: 503 followed by 200 still retries', async (t) => {
  t.plan(3)
  let attempts = 0
  const server = await startServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.statusCode = 503
      res.end('unavailable')
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })
  t.teardown(server.close.bind(server))

  const { statusCode, body } = await request(`http://127.0.0.1:${server.address().port}`)
  t.equal(statusCode, 200)
  t.equal(await body.text(), 'ok')
  t.equal(attempts, 2)
})
