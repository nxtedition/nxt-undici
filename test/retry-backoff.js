import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'
import { backoffDelay } from '../lib/interceptor/response-retry.js'

// ---------------------------------------------------------------------------
// backoffDelay unit: exponential curve, equal jitter, cap
// ---------------------------------------------------------------------------

test('backoffDelay: first retry is immediate', (t) => {
  t.equal(backoffDelay(0, 10e3), 0)
  t.equal(backoffDelay(-1, 10e3), 0)
  t.end()
})

test('backoffDelay: exponential with 50-100% jitter', (t) => {
  // [retryCount, maxDelay, base after cap]
  const cases = [
    [1, 10e3, 1e3],
    [2, 10e3, 2e3],
    [4, 10e3, 8e3],
    // capped: 2^(n-1)s exceeds maxDelay
    [5, 10e3, 10e3],
    [8, 10e3, 10e3],
    // custom cap engages between the exponential steps
    [6, 30e3, 30e3],
    // 2^large overflows to Infinity — cap must still bound it
    [2000, 10e3, 10e3],
    // a huge maxDelay is clamped to the ~2^31-1 ms timer max — setTimeout
    // would otherwise overflow and fire immediately
    [40, 2 ** 40, 2 ** 31 - 1],
    [2000, Number.MAX_SAFE_INTEGER, 2 ** 31 - 1],
  ]
  for (const [retryCount, maxDelay, base] of cases) {
    for (let i = 0; i < 20; i++) {
      const delay = backoffDelay(retryCount, maxDelay)
      if (!(delay >= base / 2 && delay < base)) {
        t.fail(
          `backoffDelay(${retryCount}, ${maxDelay}) = ${delay}, expected [${base / 2}, ${base})`,
        )
      }
    }
  }
  t.equal(backoffDelay(3, 0), 0, 'maxDelay 0 clamps to no wait')
  t.pass('all sampled delays within [base/2, base)')
  t.end()
})

// ---------------------------------------------------------------------------
// retry.maxDelay plumbs through to the connection-error backoff
// ---------------------------------------------------------------------------

test('retry: maxDelay caps the backoff between connection-error attempts', async (t) => {
  let callCount = 0
  const mockDispatch = (opts, handler) => {
    callCount++
    handler.onConnect(() => {})
    if (callCount <= 2) {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:1')
      err.code = 'ECONNREFUSED'
      handler.onError(err)
    } else {
      handler.onHeaders(200, {}, () => {})
      handler.onData(Buffer.from('ok'))
      handler.onComplete({})
    }
    return true
  }
  const dispatch = compose(mockDispatch, interceptors.responseRetry())

  const start = Date.now()
  const result = await new Promise((resolve, reject) => {
    let statusCode
    dispatch(
      { method: 'GET', path: '/', origin: 'http://x', retry: { count: 3, maxDelay: 20 } },
      {
        onConnect() {},
        onHeaders(sc) {
          statusCode = sc
          return true
        },
        onData() {},
        onComplete() {
          resolve(statusCode)
        },
        onError: reject,
      },
    )
  })
  const elapsed = Date.now() - start

  t.equal(result, 200)
  t.equal(callCount, 3)
  // The second retry (retryCount 1) waits 500-1000ms under the default cap;
  // with maxDelay 20 both waits must stay within [0, 20]ms + timer slop.
  t.ok(elapsed < 500, `elapsed ${elapsed}ms`)
})

// ---------------------------------------------------------------------------
// retry.maxDelay also applies to the status-code backoff (no retry-after)
// ---------------------------------------------------------------------------

test('retry: maxDelay caps the backoff for 503 without retry-after', async (t) => {
  let callCount = 0
  const mockDispatch = (opts, handler) => {
    callCount++
    handler.onConnect(() => {})
    if (callCount <= 2) {
      const err = new Error('service unavailable')
      err.statusCode = 503
      handler.onError(err)
    } else {
      handler.onHeaders(200, {}, () => {})
      handler.onData(Buffer.from('ok'))
      handler.onComplete({})
    }
    return true
  }
  const dispatch = compose(mockDispatch, interceptors.responseRetry())

  const start = Date.now()
  const result = await new Promise((resolve, reject) => {
    let statusCode
    dispatch(
      { method: 'GET', path: '/', origin: 'http://x', retry: { count: 3, maxDelay: 20 } },
      {
        onConnect() {},
        onHeaders(sc) {
          statusCode = sc
          return true
        },
        onData() {},
        onComplete() {
          resolve(statusCode)
        },
        onError: reject,
      },
    )
  })
  const elapsed = Date.now() - start

  t.equal(result, 200)
  t.equal(callCount, 3)
  t.ok(elapsed < 500, `elapsed ${elapsed}ms`)
})
