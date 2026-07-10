import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

test('response error preserves the terminal body-resume status', async (t) => {
  let attempts = 0
  const firstError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })

  const dispatch = compose(
    (opts, handler) => {
      attempts++
      handler.onConnect(() => {})

      if (attempts === 1) {
        handler.onHeaders(
          200,
          { 'content-length': '10', etag: '"same"', 'x-attempt': 'first' },
          () => {},
        )
        handler.onData(Buffer.from('hello'))
        handler.onError(firstError)
      } else {
        // response-retry does not expose these resume headers after the first
        // response's headers have reached the caller. It instead reports this
        // attempt's status on the terminal error.
        handler.onHeaders(503, { 'x-attempt': 'second' }, () => {})
        handler.onComplete([])
      }
    },
    interceptors.responseRetry(),
    interceptors.responseError(),
  )

  const err = await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
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
          reject(new Error('request unexpectedly completed'))
        },
        onError: resolve,
      },
    )
  })

  t.equal(attempts, 2, 'made the initial request and one body-resume attempt')
  t.equal(err.statusCode, 503, 'keeps the status from the terminal resume failure')
  t.equal(err.res.statusCode, 503, 'decorated response metadata uses the terminal status')
  t.match(err.message, /503/, 'keeps the retry layer error describing the failed attempt')
  t.equal(err.cause, firstError, 'keeps the original connection failure as the cause')
})
