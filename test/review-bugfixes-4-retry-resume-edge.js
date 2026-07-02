import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'tap'
import undici from '@nxtedition/undici'
import { compose, interceptors, request } from '../lib/index.js'

// Regression tests for range-resume edge cases in
// lib/interceptor/response-retry.js:
//
// 1. A 200 with content-length: 0 that errors between headers and complete
//    must deliver the ORIGINAL error — not an AssertionError from the resume
//    branch (`bytes=0--1` is not a resumable range).
// 2. Flat [name, value, ...] array request headers (legal for direct
//    dispatch()/compose() users) must be normalized before the resume
//    re-dispatch — not spread into garbage '0'/'1' header names.
// 3. When a resume at pos 0 is answered with a full 200 (server ignored
//    Range), the NEW response's etag/content-length must replace the stale
//    resume metadata for any subsequent resume.
// 4. When a resume attempt is answered with an unexpected status (e.g. 503),
//    the surfaced error must describe THAT response — not only the stale
//    error from the previous failure.
// 5. A pos 0 resume with no usable etag (e.g. the server sent a weak etag,
//    which is discarded) must not send an if-match header at all — a null
//    etag would go on the wire as an invalid empty `if-match:` value.
// 6. An if-match written by a PREVIOUS resume attempt must not leak into the
//    next resume once #etag has been cleared (full-200 restart with a weak
//    etag) — the re-dispatch spreads the reassigned opts.headers, so the
//    stale validator persists unless it is deleted before the conditional
//    re-set.

// ---------------------------------------------------------------------------
// Bug 1: zero-length body + error between headers and complete.
//
// Driven with a mock dispatch: a real HTTP server cannot produce this window,
// because with content-length: 0 the client parser completes the message as
// soon as the headers arrive — so the socket teardown is only observable
// between onHeaders and onComplete at the handler level.
// ---------------------------------------------------------------------------

test('retry: zero-length body error after headers delivers original error, not AssertionError', async (t) => {
  t.plan(3)

  const originalErr = Object.assign(new Error('kaboom'), { code: 'ECONNRESET' })

  let dispatches = 0
  const mockDispatch = (opts, handler) => {
    dispatches++
    handler.onConnect(() => {})
    handler.onHeaders(200, { 'content-length': '0', etag: '"zero"' }, () => {})
    // Socket dies between headers and message complete.
    handler.onError(originalErr)
    return true
  }
  const dispatch = compose(mockDispatch, interceptors.responseRetry())

  const err = await new Promise((resolve, reject) => {
    dispatch(
      { method: 'GET', path: '/', origin: 'http://x', retry: () => true },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          reject(new Error('should not complete'))
        },
        onError: resolve,
      },
    )
  })

  t.not(err.name, 'AssertionError', 'must not surface an internal AssertionError')
  t.equal(err, originalErr, 'the original network error is delivered')
  t.equal(dispatches, 1, 'no resume attempt is dispatched for a zero-length body')
})

// ---------------------------------------------------------------------------
// Bug 2: flat-array request headers must survive the resume re-dispatch.
// Uses direct compose() + a real server — the request() wrapper normalizes
// headers up front, so only direct dispatch users hit this path.
// ---------------------------------------------------------------------------

test('retry: flat-array request headers are normalized on range resume re-dispatch', async (t) => {
  t.plan(6)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, { 'content-length': '10', etag: '"arr"' })
      res.write('hello')
      setTimeout(() => res.destroy(), 50)
    } else {
      t.equal(req.headers.range, 'bytes=5-9', 'resume sends a proper range header')
      t.equal(req.headers['if-match'], '"arr"', 'resume sends if-match with the etag')
      t.equal(req.headers['x-foo'], 'bar', 'original array header arrives under its real name')
      t.notOk(req.headers['0'], 'no numeric "0" header on the wire')
      t.notOk(req.headers['1'], 'no numeric "1" header on the wire')
      res.writeHead(206, { 'content-range': 'bytes 5-9/10', 'content-length': '5', etag: '"arr"' })
      res.end('world')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')

  const agent = new undici.Agent()
  t.teardown(() => agent.close())
  const dispatch = compose(agent, interceptors.responseRetry())

  const body = await new Promise((resolve, reject) => {
    const chunks = []
    dispatch(
      {
        method: 'GET',
        path: '/',
        origin: `http://0.0.0.0:${server.address().port}`,
        headers: ['x-foo', 'bar'],
        retry: () => true,
      },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData(chunk) {
          chunks.push(chunk)
        },
        onComplete() {
          resolve(Buffer.concat(chunks).toString())
        },
        onError: reject,
      },
    )
  })

  t.equal(body, 'helloworld', 'body resumed correctly')
})

// ---------------------------------------------------------------------------
// Bug 3: full-200 restart of a resume must refresh #end/#etag from the NEW
// response, so a second failure resumes against the new representation.
// verify: false because the consumer intentionally receives more bytes than
// the first response's content-length announced (the restart is longer).
// ---------------------------------------------------------------------------

test('retry: full-200 restart refreshes resume metadata (new etag/content-length)', async (t) => {
  t.plan(4)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      // Headers only — no body bytes forwarded — then die, so the resume
      // starts at pos 0.
      res.writeHead(200, { 'content-length': '10', etag: '"v1"' })
      res.flushHeaders()
      setTimeout(() => res.destroy(), 50)
    } else if (attempts === 2) {
      t.equal(req.headers['if-match'], '"v1"', 'first resume validates against the old etag')
      // Server ignores Range and restarts from scratch with a NEW etag and a
      // NEW (longer) content-length, then dies mid-body.
      res.writeHead(200, { 'content-length': '20', etag: '"v2"' })
      res.write('AAAAA')
      setTimeout(() => res.destroy(), 50)
    } else {
      // The second resume must be based on the restarted response's metadata.
      t.equal(req.headers['if-match'], '"v2"', 'second resume validates against the NEW etag')
      t.equal(req.headers.range, 'bytes=5-19', 'second resume range uses the NEW content-length')
      res.writeHead(206, { 'content-range': 'bytes 5-19/20', 'content-length': '15', etag: '"v2"' })
      res.end('BBBBBBBBBBBBBBB')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')

  const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
    retry: () => true,
    verify: false,
  })
  const text = await body.text()
  t.equal(text, 'AAAAA' + 'BBBBBBBBBBBBBBB', 'restarted body is forwarded seamlessly')
})

// ---------------------------------------------------------------------------
// Bug 4: a resume attempt answered with 503 must surface an error describing
// the 503 — not (only) the stale error from the previous failure.
// ---------------------------------------------------------------------------

test('retry: resume attempt answered with 503 surfaces the 503, not the stale prior error', async (t) => {
  t.plan(5)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, { 'content-length': '10', etag: '"s"' })
      res.write('hello')
      setTimeout(() => res.destroy(), 50)
    } else {
      res.statusCode = 503
      res.end('unavailable')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')

  try {
    // error: false keeps the response-error interceptor out of the chain —
    // it re-decorates errors with the statusCode of the headers IT saw (the
    // first 200), which would mask the statusCode set by the retry layer.
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: () => true,
      error: false,
    })
    await body.text()
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.statusCode, 503, 'error reflects the resume attempt status')
    t.match(err.message, /503/, 'message describes the current failure')
    t.ok(err.cause, 'the previous failure is preserved as cause')
    t.not(err.cause?.statusCode, 503, 'cause is the prior network error, not the 503')
  }
  t.equal(attempts, 2, 'initial attempt + one resume attempt')
})

// ---------------------------------------------------------------------------
// Bug 5: pos 0 resume without a usable etag must not send if-match.
// A weak etag is discarded by the retry handler (not byte-comparable), so the
// resume re-dispatch holds no etag — writing it unconditionally sends an
// invalid empty `if-match:` header on the wire.
// ---------------------------------------------------------------------------

test('retry: pos 0 resume without a usable etag omits the if-match header', async (t) => {
  t.plan(4)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      // Weak etag → discarded; headers only, then die, so the resume starts
      // at pos 0 with no etag to validate against.
      res.writeHead(200, { 'content-length': '5', etag: 'W/"weak"' })
      res.flushHeaders()
      setTimeout(() => res.destroy(), 50)
    } else {
      t.notOk('if-match' in req.headers, 'no if-match header on the wire')
      t.equal(req.headers.range, 'bytes=0-4', 'resume still requests the full range')
      res.writeHead(200, { 'content-length': '5' })
      res.end('hello')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')

  const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
    retry: () => true,
  })
  const text = await body.text()
  t.equal(text, 'hello', 'body delivered after the etag-less pos 0 resume')
  t.equal(attempts, 2, 'initial attempt + one resume attempt')
})

// ---------------------------------------------------------------------------
// Bug 6: a stale if-match from a previous resume attempt must not leak into
// the next resume after #etag was cleared. The resume re-dispatch REASSIGNS
// this.#opts with the if-match merged into headers; the next resume spreads
// those headers, so the old validator survives unless deleted before the
// conditional re-set.
// ---------------------------------------------------------------------------

test('retry: stale if-match from a previous resume is not sent once the etag is cleared', async (t) => {
  t.plan(5)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      // Strong etag; headers only, then die → resume starts at pos 0 holding
      // etag "v1".
      res.writeHead(200, { 'content-length': '10', etag: '"v1"' })
      res.flushHeaders()
      setTimeout(() => res.destroy(), 50)
    } else if (attempts === 2) {
      t.equal(req.headers['if-match'], '"v1"', 'first resume validates against the held etag')
      // Full-200 restart with a WEAK etag → the retry handler clears #etag.
      // Die again before any body byte, forcing a second pos 0 resume.
      res.writeHead(200, { 'content-length': '10', etag: 'W/"v2"' })
      res.flushHeaders()
      setTimeout(() => res.destroy(), 50)
    } else {
      // No usable etag is held any more — the stale "v1" validator from the
      // first resume must NOT be replayed on the wire.
      t.notOk('if-match' in req.headers, 'stale if-match is not carried into the second resume')
      t.equal(req.headers.range, 'bytes=0-9', 'second resume still requests the full range')
      res.writeHead(200, { 'content-length': '10' })
      res.end('helloworld')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')

  const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
    retry: () => true,
  })
  const text = await body.text()
  t.equal(text, 'helloworld', 'body delivered after the second resume')
  t.equal(attempts, 3, 'initial attempt + two resume attempts')
})
