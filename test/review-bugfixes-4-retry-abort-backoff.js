import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import tp from 'node:timers/promises'
import { errors } from '@nxtedition/undici'
import { compose, interceptors, request, getGlobalDispatcher } from '../lib/index.js'

// Regression tests: a downstream abort that lands DURING the retry backoff
// wait (after an attempt finished, before the next one is dispatched) must:
//   - deliver exactly one terminal onError with the abort reason, promptly
//     (previously raw dispatch never received a terminal event at all), and
//   - cancel the pending backoff timer (previously a ref'd timer held the
//     event loop for up to 60s of retry-after).

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

function start503Server() {
  return startServer((req, res) => {
    res.statusCode = 503
    res.setHeader('retry-after', '30')
    res.end('unavailable')
  })
}

// ---------------------------------------------------------------------------
// Raw dispatch: abort during backoff → prompt terminal onError(reason)
// ---------------------------------------------------------------------------

test('retry: abort during backoff delivers onError with the reason (raw dispatch)', async (t) => {
  t.plan(4)

  const server = await start503Server()
  t.teardown(server.close.bind(server))

  const firstAttempt = once(server, 'request')
  const dispatch = compose(getGlobalDispatcher(), interceptors.responseRetry())

  const reason = new Error('user aborted during backoff')
  let abort = null
  let errorCount = 0

  const onError = new Promise((resolve) => {
    dispatch(
      {
        origin: `http://127.0.0.1:${server.address().port}`,
        path: '/',
        method: 'GET',
        retry: true,
      },
      {
        onConnect(a) {
          abort ??= a
        },
        onHeaders() {
          return true
        },
        onData() {
          return true
        },
        onComplete() {
          t.fail('should not complete')
        },
        onError(err) {
          errorCount++
          resolve(err)
        },
      },
    )
  })

  // Let the first (503) attempt finish so the 30s retry-after backoff starts.
  await firstAttempt
  await tp.setTimeout(200)

  t.ok(abort, 'abort captured from onConnect')

  const abortedAt = Date.now()
  abort(reason)

  const err = await Promise.race([onError, tp.setTimeout(2000, null)])

  t.equal(err, reason, 'onError receives the abort reason')
  t.ok(Date.now() - abortedAt < 1500, 'terminal error is prompt, not after the 30s backoff')

  // Give any duplicate terminal event a chance to fire.
  await tp.setTimeout(100)
  t.equal(errorCount, 1, 'exactly one onError')
})

// ---------------------------------------------------------------------------
// Raw dispatch: abort with no reason → RequestAbortedError fallback
// ---------------------------------------------------------------------------

test('retry: reasonless abort during backoff falls back to RequestAbortedError', async (t) => {
  t.plan(4)

  const server = await start503Server()
  t.teardown(server.close.bind(server))

  const firstAttempt = once(server, 'request')
  const dispatch = compose(getGlobalDispatcher(), interceptors.responseRetry())

  let abort = null

  const onError = new Promise((resolve) => {
    dispatch(
      {
        origin: `http://127.0.0.1:${server.address().port}`,
        path: '/',
        method: 'GET',
        retry: true,
      },
      {
        onConnect(a) {
          abort ??= a
        },
        onHeaders() {
          return true
        },
        onData() {
          return true
        },
        onComplete() {
          t.fail('should not complete')
        },
        onError(err) {
          resolve(err)
        },
      },
    )
  })

  await firstAttempt
  await tp.setTimeout(200)

  const abortedAt = Date.now()
  abort()

  const err = await Promise.race([onError, tp.setTimeout(2000, null)])

  t.ok(err, 'terminal onError delivered')
  t.ok(err instanceof errors.RequestAbortedError, 'uses the dependency error class')
  t.equal(err?.code, 'UND_ERR_ABORTED', 'fallback is a RequestAbortedError')
  t.ok(Date.now() - abortedAt < 1500, 'terminal error is prompt')
})

// ---------------------------------------------------------------------------
// request(): AbortController abort during backoff → prompt rejection with the
// abort reason (previously the timer's own AbortError or, without a real
// AbortSignal, a 30s stall).
// ---------------------------------------------------------------------------

test('retry: signal abort during backoff rejects promptly with the abort reason', async (t) => {
  t.plan(3)

  let attempts = 0
  const server = await startServer((req, res) => {
    attempts++
    res.statusCode = 503
    res.setHeader('retry-after', '30')
    res.end('unavailable')
  })
  t.teardown(server.close.bind(server))

  const ac = new AbortController()
  const reason = new Error('user aborted request')

  const firstAttempt = once(server, 'request')
  const started = Date.now()

  const pending = request(`http://127.0.0.1:${server.address().port}`, {
    signal: ac.signal,
    retry: true,
  })
  // Swallow late rejections if assertions below fail first.
  pending.catch(() => {})

  await firstAttempt
  await tp.setTimeout(200)
  ac.abort(reason)

  try {
    await pending
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err, reason, 'rejects with the abort reason, not a generic error')
  }

  t.ok(Date.now() - started < 5000, 'rejects promptly, not after the 30s retry-after')
  t.equal(attempts, 1, 'no further attempts after abort')
})
