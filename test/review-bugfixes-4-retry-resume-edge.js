import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'tap'
import undici from '@nxtedition/undici'
import { compose, interceptors, request } from '../lib/index.js'

// Regression tests for range-resume edge cases in
// lib/interceptor/response-retry.js:
//
// 1. A 200 with a non-positive content-length (0, or an invalid negative
//    value like -5) that errors between headers and complete must deliver the
//    ORIGINAL error — not an AssertionError from the resume branch (neither
//    yields a resumable range).
// 2. Flat [name, value, ...] array request headers (legal for direct
//    dispatch()/compose() users) must be normalized before the resume
//    re-dispatch — not spread into garbage '0'/'1' header names.
// 3. A resume at pos 0 answered with a full 200 whose strong etag DIFFERS from
//    the if-match the resume carried must be declined, not spliced: its body
//    describes a different representation than the first-attempt headers that
//    were already forwarded downstream (and, behind a cache, already stored)
//    — see issue #69.
// 4. When a resume attempt is answered with an unexpected status (e.g. 503),
//    the surfaced error must describe THAT response — not only the stale
//    error from the previous failure.
// 5. A pos 0 resume with no usable etag (e.g. the server sent a weak etag,
//    which is discarded) sends no if-match — so a full-200 restart cannot be
//    proven to match the already-forwarded headers and must be declined rather
//    than spliced (issue #69). The resume request itself still omits if-match
//    (a null etag would go on the wire as an invalid empty `if-match:` value).
// 6. A full-200 restart that echoes the SAME strong etag as the resume's
//    if-match is provably the same representation, so it is accepted and a
//    subsequent failure resumes from where the restart left off, still
//    validating against that etag.

// ---------------------------------------------------------------------------
// Bug 1: non-positive content-length + error between headers and complete.
//
// Driven with a mock dispatch: a real HTTP server cannot produce this window,
// because with content-length: 0 the client parser completes the message as
// soon as the headers arrive — so the socket teardown is only observable
// between onHeaders and onComplete at the handler level. The negative variant
// is mock-only too: a real server/parser never emits a negative
// content-length.
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

test('retry: negative content-length error after headers delivers original error, not AssertionError', async (t) => {
  t.plan(3)

  const originalErr = Object.assign(new Error('kaboom'), { code: 'ECONNRESET' })

  let dispatches = 0
  const mockDispatch = (opts, handler) => {
    dispatches++
    handler.onConnect(() => {})
    // Invalid but finite content-length: Number('-5') passes the
    // Number.isFinite screen in onHeaders, so #end is tracked as -5 — the
    // resume guard must treat it as non-resumable, not just #end === 0.
    handler.onHeaders(200, { 'content-length': '-5', etag: '"neg"' }, () => {})
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
  t.equal(dispatches, 1, 'no resume attempt is dispatched for a negative content-length')
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
// Bug 3 (issue #69): a full-200 restart of a resume whose strong etag DIFFERS
// from the if-match carried must be declined, not spliced. The first attempt's
// headers were already forwarded downstream (and, behind a cache, used to build
// the stored entry); splicing a body from a different representation onto them
// would persist the first attempt's headers/cache-control/TTL/validators with
// the second attempt's body.
// ---------------------------------------------------------------------------

test('retry: full-200 restart with a changed etag is declined, not spliced', async (t) => {
  t.plan(3)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      // Headers only — no body bytes forwarded — then die, so the resume
      // starts at pos 0 holding the strong etag "v1".
      res.writeHead(200, { 'content-length': '10', etag: '"v1"' })
      res.flushHeaders()
      setTimeout(() => res.destroy(), 50)
    } else {
      t.equal(req.headers['if-match'], '"v1"', 'resume validates against the first etag')
      // A compliant origin answers if-match against a CHANGED representation
      // with 412; this one ignores it and restarts a full 200 with a DIFFERENT
      // strong etag. Splicing that body onto the already-forwarded first-attempt
      // headers must be declined.
      res.writeHead(200, { 'content-length': '10', etag: '"v2"' })
      res.end('helloworld')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')

  const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
    retry: () => true,
  })
  await t.rejects(
    body.text(),
    /Response retry failed/,
    'the mismatched restart is declined instead of spliced',
  )
  t.equal(attempts, 2, 'initial attempt + one declined resume attempt')
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
// Bug 5 (issue #69): a pos 0 resume without a usable etag sends no if-match, so
// a full-200 restart cannot be proven to be the same representation as the
// already-forwarded headers — it must be declined rather than spliced. The
// resume request itself still omits if-match (a weak etag is discarded by the
// retry handler, and a null etag would go on the wire as an invalid empty
// `if-match:` value).
// ---------------------------------------------------------------------------

test('retry: pos 0 restart without a usable etag is declined (and sends no if-match)', async (t) => {
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
      t.notOk('if-match' in req.headers, 'no if-match header on the wire (nothing to validate)')
      t.equal(req.headers.range, 'bytes=0-4', 'resume still requests the full range')
      // No validator was sent, so this full 200 cannot be proven to match the
      // already-forwarded first-attempt headers — it must be declined.
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
  await t.rejects(
    body.text(),
    /Response retry failed/,
    'the unvalidated restart is declined instead of spliced',
  )
  t.equal(attempts, 2, 'initial attempt + one declined resume attempt')
})

// ---------------------------------------------------------------------------
// Bug 6 (issue #69): a full-200 restart that echoes the SAME strong etag as the
// resume's if-match is provably the same representation, so it is accepted; a
// subsequent failure then resumes from where the restart left off, still
// validating against that etag.
// ---------------------------------------------------------------------------

test('retry: full-200 restart echoing the same strong etag is accepted and resumes', async (t) => {
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
      // Server ignored Range and restarted the full 200, but echoes the SAME
      // strong etag → provably the same representation, so the restart is
      // accepted. Forward a few bytes then die, forcing a second resume that
      // must continue from the restart offset.
      res.writeHead(200, { 'content-length': '10', etag: '"v1"' })
      res.write('hello')
      setTimeout(() => res.destroy(), 50)
    } else {
      t.equal(req.headers['if-match'], '"v1"', 'second resume still validates against "v1"')
      t.equal(req.headers.range, 'bytes=5-9', 'second resume continues from the restart offset')
      res.writeHead(206, { 'content-range': 'bytes 5-9/10', 'content-length': '5', etag: '"v1"' })
      res.end('world')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')

  const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
    retry: () => true,
  })
  const text = await body.text()
  t.equal(text, 'helloworld', 'the accepted restart body is forwarded seamlessly')
  t.equal(attempts, 3, 'initial attempt + two resume attempts')
})
