import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

test('retry: an unexpected resume status reports the current response headers', async (t) => {
  t.plan(9)

  const firstError = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
  const retryHeaders = {
    'content-length': '0',
    'retry-after': '17',
    'x-response-attempt': 'resume',
  }

  let attempts = 0
  const dispatch = compose((opts, handler) => {
    attempts++
    handler.onConnect(() => {})

    if (attempts === 1) {
      t.equal(
        handler.onHeaders(200, { 'content-length': '10', etag: '"v1"' }, () => {}),
        true,
        'the initial response is forwarded',
      )
      handler.onData(Buffer.from('hello'))
      handler.onError(firstError)
    } else {
      t.equal(
        handler.onHeaders(503, retryHeaders, () => {}),
        false,
        'the unexpected resume response is rejected',
      )
    }

    return true
  }, interceptors.responseRetry())

  const err = await new Promise((resolve, reject) => {
    dispatch(
      {
        method: 'GET',
        origin: 'http://example.test',
        path: '/',
        headers: {},
        retry: () => true,
      },
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

  t.equal(attempts, 2, 'one initial request and one resume request were dispatched')
  t.equal(err.statusCode, 503, 'the current attempt status remains available at top level')
  t.equal(err.res.statusCode, 503, 'response metadata identifies the current attempt')
  t.same(err.res.headers, retryHeaders, 'response metadata contains the current attempt headers')
  t.equal(err.res.trailers, null, 'trailers are null because the attempt ended at headers')
  t.equal(err.body, undefined, 'no stale buffered body is attached to the terminal error')
  t.equal(err.cause, firstError, 'the failure that triggered the resume remains the cause')
})
