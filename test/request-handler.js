/* eslint-disable */
// Unit tests for lib/request.js — covers validation branches and URL-parsing
// edge cases that are never reached via the high-level wrapDispatch stack.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { RequestHandler, request } from '../lib/request.js'

// ---------------------------------------------------------------------------
// RequestHandler constructor validation
// ---------------------------------------------------------------------------

test('RequestHandler: invalid resolve throws InvalidArgumentError', (t) => {
  t.plan(1)
  t.throws(
    () => new RequestHandler({ method: 'GET', body: null }, 'not-a-function'),
    /invalid resolve/,
  )
})

test('RequestHandler: invalid highWaterMark throws InvalidArgumentError', (t) => {
  t.plan(1)
  t.throws(
    () => new RequestHandler({ method: 'GET', body: null, highWaterMark: -1 }, () => {}),
    /invalid highWaterMark/,
  )
})

test('RequestHandler: non-numeric highWaterMark throws', (t) => {
  t.plan(1)
  t.throws(
    () => new RequestHandler({ method: 'GET', body: null, highWaterMark: 'big' }, () => {}),
    /invalid highWaterMark/,
  )
})

test('RequestHandler: invalid signal (no on/addEventListener) throws', (t) => {
  t.plan(1)
  t.throws(
    () => new RequestHandler({ method: 'GET', body: null, signal: { someField: true } }, () => {}),
    /signal must be an EventEmitter or EventTarget/,
  )
})

test('RequestHandler: CONNECT method throws InvalidArgumentError', (t) => {
  t.plan(1)
  t.throws(() => new RequestHandler({ method: 'CONNECT', body: null }, () => {}), /invalid method/)
})

test('RequestHandler: stream body is destroyed when constructor throws', (t) => {
  t.plan(1)
  const body = new Readable({ read() {} })
  let destroyed = false
  body.on('close', () => {
    destroyed = true
  })

  try {
    new RequestHandler({ method: 'CONNECT', body }, () => {})
  } catch {
    // expected
  }

  // The stream is destroyed inside the catch block (lines 35-38)
  setImmediate(() => {
    t.ok(destroyed || body.destroyed, 'stream body destroyed when constructor throws')
  })
})

test('RequestHandler: closed stream body is set to null', async (t) => {
  t.plan(1)
  const body = new Readable({ read() {} })
  body.destroy() // closed stream

  // Wait for the stream to fully close before checking
  await once(body, 'close')

  const handler = new RequestHandler({ method: 'GET', body }, () => {})
  // After body.closed is detected, handler.body should be null (line 11-12)
  t.equal(handler.body, null, 'closed stream body is nulled')
})

test('RequestHandler: pre-aborted signal aborts immediately in onConnect', (t) => {
  t.plan(1)
  const ac = new AbortController()
  ac.abort(new Error('pre-aborted'))

  const handler = new RequestHandler({ method: 'GET', body: null, signal: ac.signal }, () => {})

  let abortCalled = false
  handler.onConnect((reason) => {
    abortCalled = true
  })
  t.ok(abortCalled, 'abort() called immediately for pre-aborted signal (lines 67-69)')
})

// ---------------------------------------------------------------------------
// RequestHandler.onHeaders: 1xx status codes return true without resolving
// ---------------------------------------------------------------------------

test('RequestHandler: 1xx status code in onHeaders returns true (lines 80-82)', (t) => {
  t.plan(2)
  let resolved = false
  const handler = new RequestHandler({ method: 'GET', body: null }, (res) => {
    resolved = true
  })

  // Simulate the lifecycle
  handler.onConnect(() => {})
  const result = handler.onHeaders(100, {}, () => {})

  t.equal(result, true, 'onHeaders returns true for 1xx')
  t.notOk(resolved, 'resolve not called for 1xx')
})

// ---------------------------------------------------------------------------
// request() URL parsing edge cases
// ---------------------------------------------------------------------------

test('request: null URL throws InvalidArgumentError (lines 162-163)', (t) => {
  t.plan(2)
  // Synchronous throws — must use t.throws, not t.rejects
  t.throws(() => request(null, null, null), /invalid url/, 'null URL throws')
  t.throws(() => request(null, 42, null), /invalid url/, 'number URL throws')
})

test('request: non-object opts throws InvalidArgumentError (lines 166-167)', (t) => {
  t.plan(1)
  t.throws(
    () => request(null, 'http://example.com', 'bad-opts'),
    /invalid opts/,
    'string opts throws',
  )
})

test('request: URL-like object without .origin uses protocol+hostname+port (lines 171-181)', async (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end()
  })
  server.listen(0)
  await once(server, 'listening')
  const port = server.address().port

  // Plain object with hostname/protocol/port but no .origin — exercises the
  // !origin branch that builds origin from parts (lines 171-181)
  const { Agent } = await import('@nxtedition/undici')
  const agent = new Agent()
  const dispatcher = (opts, handler) => agent.dispatch(opts, handler)

  // Pass a URL-like object without a .origin property — but include method
  // so undici doesn't reject the request
  await request(dispatcher, {
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: String(port),
    pathname: '/',
    method: 'GET',
  })

  server.close()
  t.ok(true, 'URL-like object without .origin resolved correctly')
})
