import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function request(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    const chunks = []

    dispatch(opts, {
      onConnect() {},
      onHeaders(status) {
        statusCode = status
        return true
      },
      onData(chunk) {
        chunks.push(chunk)
        return true
      },
      onComplete() {
        resolve({ statusCode, body: Buffer.concat(chunks).toString() })
      },
      onError: reject,
    })
  })
}

function respond(handler, statusCode, body) {
  handler.onConnect(() => {})
  handler.onHeaders(statusCode, { 'content-length': String(Buffer.byteLength(body)) }, () => {})
  handler.onData(Buffer.from(body))
  handler.onComplete({})
}

test('object-form retry strategy can veto the default retry decision', async (t) => {
  let attempts = 0
  let strategyCalls = 0
  const dispatch = compose((opts, handler) => {
    attempts++
    respond(handler, attempts === 1 ? 503 : 200, attempts === 1 ? 'unavailable' : 'ok')
  }, interceptors.responseRetry())

  const result = await request(dispatch, {
    origin: 'http://example.test',
    path: '/',
    method: 'GET',
    headers: {},
    retry: {
      count: 2,
      retry(err, retryCount, opts, defaultRetry) {
        strategyCalls++
        t.equal(err.statusCode, 503)
        t.equal(retryCount, 0)
        t.equal(opts.retry.count, 2)
        t.type(defaultRetry, 'function')
        return false
      },
    },
  })

  t.equal(strategyCalls, 1, 'the nested retry strategy was called')
  t.equal(attempts, 1, 'veto prevented the default 503 retry')
  t.same(result, { statusCode: 503, body: 'unavailable' })
})

test('object-form retry count caps a strategy that always retries', async (t) => {
  let attempts = 0
  let strategyCalls = 0
  const dispatch = compose((opts, handler) => {
    attempts++
    respond(handler, 500, 'failed')
  }, interceptors.responseRetry())

  const result = await request(dispatch, {
    origin: 'http://example.test',
    path: '/',
    method: 'GET',
    headers: {},
    retry: {
      count: 2,
      retry() {
        strategyCalls++
        return true
      },
    },
  })

  t.equal(attempts, 3, 'initial attempt plus two retries')
  t.equal(strategyCalls, 2, 'strategy is not called after the configured cap')
  t.same(result, { statusCode: 500, body: 'failed' })
})
