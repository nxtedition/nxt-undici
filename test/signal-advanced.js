/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request } from '../lib/index.js'

async function startServer(handler) {
  const server = createServer(handler ?? ((req, res) => res.end('ok')))
  server.listen(0)
  await once(server, 'listening')
  return server
}

// ---------------------------------------------------------------------------
// Abort while waiting for headers (server never responds)
// ---------------------------------------------------------------------------

test('signal: abort while waiting for headers cancels the request', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    // Never respond — keep the connection hanging
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
// Abort while consuming body (server sends partial data then hangs)
// ---------------------------------------------------------------------------

test('signal: abort mid-body consumption propagates abort error through stream', async (t) => {
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
    for await (const _ of body) {
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
// Abort with a custom reason is forwarded exactly
// ---------------------------------------------------------------------------

test('signal: custom abort reason is forwarded as the thrown error', async (t) => {
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
    t.equal(err, myReason, 'thrown error must be the exact abort reason')
  }
})

// ---------------------------------------------------------------------------
// Aborting after the body is fully consumed has no effect
// ---------------------------------------------------------------------------

test('signal: aborting after response is fully consumed does not affect result', async (t) => {
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
  ac.abort() // abort after everything is done

  t.equal(statusCode, 200)
  t.equal(text, 'done')
})
