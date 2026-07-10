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
  t.equal(err.res.headers, null, 'does not pair terminal status with earlier response headers')
  t.equal(err.res.trailers, null, 'does not pair terminal status with earlier response trailers')
  t.match(err.message, /503/, 'keeps the retry layer error describing the failed attempt')
  t.equal(err.cause, firstError, 'keeps the original connection failure as the cause')
})

test('response error preserves inner response metadata as a unit', async (t) => {
  const response = {
    statusCode: 503,
    headers: { 'x-attempt': 'second' },
    trailers: { 'x-terminal': 'yes' },
  }
  const innerError = Object.assign(new Error('terminal response failed'), {
    statusCode: 503,
    res: response,
  })

  const dispatch = compose((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, { 'x-attempt': 'first' }, () => {})
    handler.onError(innerError)
  }, interceptors.responseError())

  const err = await new Promise((resolve) => {
    dispatch(
      {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
        headers: {},
      },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {},
        onError: resolve,
      },
    )
  })

  t.equal(err, innerError, 'forwards the inner error')
  t.equal(err.res, response, 'keeps the inner response metadata object intact')
  t.same(err.res.headers, { 'x-attempt': 'second' }, 'keeps the terminal response headers')
  t.same(err.res.trailers, { 'x-terminal': 'yes' }, 'keeps the terminal response trailers')
})
