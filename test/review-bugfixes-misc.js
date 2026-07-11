/* eslint-disable */
// Regression tests for interceptor/entry-point bugs found during the in-depth
// review: proxy via-loop & Connection casing, response-verify abort, retry
// resume-at-0 & content-range mismatch & Retry-After, EventEmitter signals,
// and the request({ url }, opts) two-arg form.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once, EventEmitter } from 'node:events'
import { compose, interceptors, request, getGlobalDispatcher } from '../lib/index.js'
import { RequestHandler } from '../lib/request.js'
import undici from '@nxtedition/undici'

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

function dispatchAsync(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    let headers
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc, h) {
        statusCode = sc
        headers = h
        return true
      },
      onData() {},
      onComplete() {
        resolve({ statusCode, headers })
      },
      onError: reject,
    })
  })
}

// ---------------------------------------------------------------------------
// proxy: Via loop detection must compare the received-by token, not endsWith —
// a proxy name that is merely a suffix of an unrelated upstream must not trip.
// ---------------------------------------------------------------------------

test('proxy: Via from a suffix-colliding upstream is not a false loop', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    // 'otherproxy' ends with 'proxy' but is a different proxy — not a loop.
    res.setHeader('via', 'HTTP/1.1 otherproxy')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.proxy())
  const { statusCode, headers } = await dispatchAsync(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    proxy: { name: 'proxy' },
  })
  t.equal(statusCode, 200, 'request succeeds — no false LoopDetected')
  t.match(headers.via, /otherproxy.*proxy|proxy/, 'this proxy is appended to Via')
})

test('proxy: genuine Via loop is still detected', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.setHeader('via', 'HTTP/1.1 myproxy')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.proxy())
  await t.rejects(
    dispatchAsync(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
      path: '/',
      method: 'GET',
      headers: {},
      proxy: { name: 'myproxy' },
    }),
    /Loop/,
    'a real loop still throws LoopDetected',
  )
})

// ---------------------------------------------------------------------------
// proxy: header names listed in Connection are case-insensitive (RFC 7230).
// ---------------------------------------------------------------------------

test('proxy: Connection-listed header is stripped regardless of case', async (t) => {
  t.plan(2)
  let received
  const server = await startServer((req, res) => {
    received = req.headers
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.proxy())
  await dispatchAsync(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { connection: 'X-Per-Hop', 'x-per-hop': 'secret' },
    proxy: { name: 'p' },
  })
  t.equal(received['x-per-hop'], undefined, 'mixed-case Connection-listed header is stripped')
  t.notOk('x-per-hop' in received, 'header must not leak to the next hop')
})

// ---------------------------------------------------------------------------
// response-verify: a mid-stream size overflow must abort the transport, not
// just call onError and leave the socket paused.
// ---------------------------------------------------------------------------

test('response-verify: mid-stream size overflow aborts the transport', (t) => {
  t.plan(2)

  let aborted = false
  const fakeDispatch = (opts, handler) => {
    handler.onConnect(() => {
      aborted = true
    })
    handler.onHeaders(200, { 'content-length': '5' }, () => {})
    handler.onData(Buffer.from('123456')) // 6 bytes — exceeds 5
  }

  const dispatch = interceptors.responseVerify()(fakeDispatch)

  let errored
  dispatch(
    { verify: { size: true }, method: 'GET' },
    {
      onConnect() {},
      onHeaders() {
        return true
      },
      onData() {},
      onComplete() {},
      onError(err) {
        errored = err
      },
    },
  )

  t.ok(aborted, 'transport abort is invoked on mid-stream overflow')
  t.match(errored?.message, /exceeded/, 'consumer receives the overflow error')
})

// ---------------------------------------------------------------------------
// response-retry: a server that ignores Range and returns a full 200 when no
// bytes had been forwarded yet must succeed, not fail with "retry failed".
// ---------------------------------------------------------------------------

test('retry: full 200 on resume from offset 0 is accepted', (t) => {
  t.plan(1)
  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, { 'content-length': '5', etag: '"v1"' })
      res.flushHeaders() // headers delivered, zero body bytes
      setTimeout(() => res.destroy(), 50)
    } else {
      // Ignore the Range header; return the full representation.
      res.writeHead(200, { 'content-length': '5', etag: '"v1"' })
      res.end('hello')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: (err, n) => n < 3,
    })
    const text = await body.text()
    t.equal(text, 'hello', 'full 200 retry from offset 0 yields the complete body')
  })
})

// ---------------------------------------------------------------------------
// response-retry: a mismatched content-range on a body-resume retry must
// deliver a graceful error to the consumer, not throw an AssertionError out of
// onHeaders (which would hang the stream).
// ---------------------------------------------------------------------------

test('retry: mismatched content-range on resume errors gracefully (no hang)', (t) => {
  t.plan(1)
  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, { 'content-length': '10', etag: '"v2"' })
      res.write('ABCDE') // 5 of 10 bytes
      setTimeout(() => res.destroy(), 50)
    } else {
      // Wrong start: we requested bytes=5- but the server claims bytes 0-9.
      res.writeHead(206, { 'content-range': 'bytes 0-9/10', 'content-length': '10', etag: '"v2"' })
      res.end('ABCDEFGHIJ')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: (err, n) => n < 3,
    })
    await t.rejects(body.text(), /retry failed/, 'consumer gets a terminal error, not a hang')
  })
})

// ---------------------------------------------------------------------------
// response-retry: Retry-After is honored for both delta-seconds and HTTP-date.
// (Without honoring it, the first retry would fire at the ~0ms default backoff.)
// ---------------------------------------------------------------------------

test('retry: Retry-After delta-seconds is honored', (t) => {
  t.plan(2)
  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(503, { 'retry-after': '1' })
      res.end('busy')
    } else {
      res.writeHead(200, {})
      res.end('ok')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const start = Date.now()
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {})
    const text = await body.text()
    const elapsed = Date.now() - start
    t.equal(text, 'ok')
    t.ok(elapsed >= 800, `waited ~1s as instructed (was ${elapsed}ms)`)
  })
})

test('retry: Retry-After HTTP-date is honored', (t) => {
  t.plan(2)
  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      // HTTP-date has whole-second resolution, so use +2s: truncation still
      // leaves at least ~1s of delay to observe.
      res.writeHead(503, { 'retry-after': new Date(Date.now() + 2000).toUTCString() })
      res.end('busy')
    } else {
      res.writeHead(200, {})
      res.end('ok')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const start = Date.now()
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {})
    const text = await body.text()
    const elapsed = Date.now() - start
    t.equal(text, 'ok')
    t.ok(elapsed >= 800, `HTTP-date Retry-After honored (~1s, was ${elapsed}ms)`)
  })
})

// ---------------------------------------------------------------------------
// RequestHandler: an EventEmitter abort signal (accepted by validation) must
// not crash the constructor and must still propagate abort.
// ---------------------------------------------------------------------------

test('RequestHandler: EventEmitter signal does not crash and propagates abort', (t) => {
  t.plan(2)

  const signal = new EventEmitter()
  signal.aborted = false

  let handler
  t.doesNotThrow(() => {
    handler = new RequestHandler({ method: 'GET', body: null, signal }, (value) => {
      // RequestHandler settles aborts through the promise resolver. This unit
      // callback is not a native resolver, so explicitly observe the adopted
      // rejection instead of leaving it unhandled.
      void Promise.resolve(value).catch(() => {})
    })
  }, 'constructing with an EventEmitter signal does not throw')

  let abortReason
  handler.onConnect((reason) => {
    abortReason = reason
  })
  signal.reason = new Error('boom')
  signal.emit('abort')

  t.equal(abortReason?.message, 'boom', 'abort propagates from the EventEmitter signal')
})

// ---------------------------------------------------------------------------
// dns: a synchronous throw from the downstream dispatch must surface via
// handler.onError (and must not leak record.pending — guarded by onSettle).
// ---------------------------------------------------------------------------

test('dns: synchronous dispatch throw surfaces via onError', (t) => {
  t.plan(1)
  const boom = new Error('sync boom')
  const dispatch = interceptors.dns()(() => {
    throw boom
  })
  dispatch(
    { origin: 'http://localhost', path: '/', method: 'GET', headers: {}, dns: {} },
    {
      onConnect() {},
      onHeaders() {
        return true
      },
      onData() {},
      onComplete() {},
      onError(err) {
        t.equal(err, boom, 'the synchronous dispatch error reaches the consumer')
      },
    },
  )
})

// ---------------------------------------------------------------------------
// request(): an object URL with neither host nor hostname throws 'invalid url'.
// ---------------------------------------------------------------------------

test('request: object url without host/hostname throws invalid url', (t) => {
  t.plan(1)
  t.throws(() => request({ protocol: 'http:' }), /invalid url/)
})

// ---------------------------------------------------------------------------
// request({ url }, opts) two-arg object-first form should behave like the
// single-arg and string-first forms (previously threw 'invalid url').
// ---------------------------------------------------------------------------

test('request: two-arg object-first form { url } with opts works and uses the dispatcher', (t) => {
  t.plan(2)
  const server = createServer((req, res) => res.end('ok'))
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const port = server.address().port
    const inner = getGlobalDispatcher()
    let used = false
    const dispatcher = {
      dispatch(opts, handler) {
        used = true
        return inner.dispatch(opts, handler)
      },
    }
    const { body } = await request({ url: `http://0.0.0.0:${port}` }, { dispatcher })
    t.equal(await body.text(), 'ok')
    t.ok(used, 'dispatcher from the second arg is used for the object-first form')
  })
})
