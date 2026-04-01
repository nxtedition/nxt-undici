/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request } from '../lib/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startServer(handler) {
  const server = createServer(handler ?? ((req, res) => res.end('ok')))
  server.listen(0)
  await once(server, 'listening')
  return server
}

// ---------------------------------------------------------------------------
// Pre-aborted signal (before request is sent)
// ---------------------------------------------------------------------------

test('signal: already-aborted signal rejects with custom reason', async (t) => {
  t.plan(1)
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const ac = new AbortController()
  const reason = new Error('pre-aborted')
  ac.abort(reason)

  try {
    await request(`http://127.0.0.1:${server.address().port}`, {
      signal: ac.signal,
      retry: false,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err, reason)
  }
})

test('signal: already-aborted with default reason propagates AbortError', async (t) => {
  t.plan(1)
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const ac = new AbortController()
  ac.abort()

  try {
    await request(`http://127.0.0.1:${server.address().port}`, {
      signal: ac.signal,
      retry: false,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.name === 'AbortError' || err.name === 'RequestAbortedError')
  }
})

// ---------------------------------------------------------------------------
// Abort while waiting for headers
// ---------------------------------------------------------------------------

test('signal: abort while waiting for headers', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    // Intentionally never respond
  })
  t.teardown(server.close.bind(server))

  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)

  try {
    await request(`http://127.0.0.1:${server.address().port}`, {
      signal: ac.signal,
      retry: false,
      headersTimeout: 5000,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.name === 'AbortError' || err.name === 'RequestAbortedError')
  }
})

// ---------------------------------------------------------------------------
// Abort while consuming body
// ---------------------------------------------------------------------------

test('signal: abort mid-body consumption propagates AbortError', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.write('chunk1')
    // Hold the connection open — never call res.end()
  })
  t.teardown(server.close.bind(server))

  const ac = new AbortController()
  const { body } = await request(`http://127.0.0.1:${server.address().port}`, {
    signal: ac.signal,
    retry: false,
  })

  let threw = false
  try {
    for await (const chunk of body) {
      ac.abort()
    }
  } catch (err) {
    threw = true
    t.ok(err.name === 'AbortError' || err.name === 'RequestAbortedError')
  }
  if (!threw) {
    t.fail('should have thrown during body iteration')
  }
})

// ---------------------------------------------------------------------------
// Abort with a custom reason object
// ---------------------------------------------------------------------------

test('signal: custom abort reason is propagated', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    // Never respond
  })
  t.teardown(server.close.bind(server))

  const ac = new AbortController()
  const myReason = new TypeError('custom reason')
  setTimeout(() => ac.abort(myReason), 30)

  try {
    await request(`http://127.0.0.1:${server.address().port}`, {
      signal: ac.signal,
      retry: false,
      headersTimeout: 5000,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err, myReason)
  }
})

// ---------------------------------------------------------------------------
// Aborting AFTER full response has no effect
// ---------------------------------------------------------------------------

test('signal: aborting after full response does not affect resolved value', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.end('done')
  })
  t.teardown(server.close.bind(server))

  const ac = new AbortController()
  const { statusCode, body } = await request(`http://127.0.0.1:${server.address().port}`, {
    signal: ac.signal,
  })
  const text = await body.text()
  ac.abort()

  t.equal(statusCode, 200)
  t.equal(text, 'done')
})
