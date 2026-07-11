import { Writable } from 'node:stream'
import pino from 'pino'
import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function captureLogger() {
  let output = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk
      callback()
    },
  })

  return {
    logger: pino({ level: 'debug', base: null, timestamp: false }, stream),
    records() {
      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
    output() {
      return output
    },
  }
}

function makeSensitiveCause() {
  return Object.assign(new Error('safe nested cause message'), {
    code: 'ECAUSE',
    token: 'nested-arbitrary-secret',
    body: 'nested-body-secret',
    req: { headers: { authorization: 'Bearer nested-request-secret' } },
    res: {
      headers: { 'set-cookie': 'nested-response-secret' },
      trailers: { 'set-cookie': 'nested-trailer-secret' },
    },
  })
}

test('log sanitizes response-retry decorated errors without mutating them', async (t) => {
  const capture = captureLogger()
  const payload = JSON.stringify({
    code: 'UPSTREAM_FAILURE',
    reason: 'promoted-reason-secret',
    error: 'promoted-error-secret',
    payload: 'captured-body-secret',
  })
  let decoratedError

  const dispatch = compose(
    (_opts, handler) => {
      handler.onConnect(() => {})
      handler.onHeaders(
        503,
        {
          'content-type': 'application/json',
          'set-cookie': 'session=response-cookie-secret',
        },
        () => {},
      )
      handler.onData(Buffer.from(payload))
      handler.onComplete({ 'set-cookie': 'session=response-trailer-secret' })
    },
    interceptors.responseRetry(),
    interceptors.log(),
  )

  const receivedError = await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
        headers: {
          authorization: 'Bearer request-authorization-secret',
          cookie: 'session=request-cookie-secret',
        },
        retry(error) {
          decoratedError = error
          error.cause = makeSensitiveCause()
          throw error
        },
        logger: capture.logger,
      },
      {
        onConnect() {},
        onHeaders() {
          reject(new Error('unexpected response headers'))
        },
        onComplete() {
          reject(new Error('unexpected completion'))
        },
        onError: resolve,
      },
    )
  })

  const failed = capture.records().find((record) => record.msg === 'upstream request failed')

  t.equal(receivedError, decoratedError, 'the original decorated error is delivered downstream')
  t.equal(
    decoratedError.req.headers.authorization,
    'Bearer request-authorization-secret',
    'logging does not mutate request metadata on the original error',
  )
  t.equal(
    decoratedError.res.headers['set-cookie'],
    'session=response-cookie-secret',
    'logging does not mutate response metadata on the original error',
  )
  t.equal(decoratedError.body.payload, 'captured-body-secret', 'the caller retains the error body')

  t.equal(failed.err.code, 'UPSTREAM_FAILURE', 'keeps the operational error code')
  t.equal(failed.err.statusCode, 503, 'keeps the response status')
  t.type(failed.err.message, 'string', 'keeps the error message')
  t.type(failed.err.stack, 'string', 'keeps the error stack')
  t.equal(failed.err.req.headers.authorization, '[redacted]')
  t.equal(failed.err.req.headers.cookie, '[redacted]')
  t.equal(failed.err.res.headers['set-cookie'], '[redacted]')
  t.equal(failed.err.res.trailers['set-cookie'], '[redacted]')
  t.equal(failed.err.body, '[redacted]')
  t.equal(failed.err.reason, '[redacted]')
  t.equal(failed.err.error, '[redacted]')
  t.match(failed.err.message, /safe nested cause message/, 'keeps a safe cause summary')

  for (const secret of [
    'request-authorization-secret',
    'request-cookie-secret',
    'response-cookie-secret',
    'response-trailer-secret',
    'captured-body-secret',
    'promoted-reason-secret',
    'promoted-error-secret',
    'nested-arbitrary-secret',
    'nested-body-secret',
    'nested-request-secret',
    'nested-response-secret',
    'nested-trailer-secret',
  ]) {
    t.notMatch(capture.output(), new RegExp(secret), `${secret} is absent from Pino output`)
  }
})

test('log sanitizes errors thrown synchronously by an inner dispatch', (t) => {
  const capture = captureLogger()
  const failure = Object.assign(new Error('synchronous dispatch failure'), {
    code: 'ESYNC',
    statusCode: 502,
    req: { headers: { authorization: 'Bearer sync-request-secret' } },
    res: { headers: { 'set-cookie': 'sync-response-secret' }, trailers: null },
    body: 'sync-body-secret',
    cause: makeSensitiveCause(),
  })
  const dispatch = interceptors.log()(() => {
    throw failure
  })

  t.throws(
    () =>
      dispatch(
        {
          origin: 'http://example.test',
          path: '/',
          method: 'GET',
          headers: {},
          logger: capture.logger,
        },
        {},
      ),
    failure,
    'the original error is rethrown',
  )

  const failed = capture.records().find((record) => record.msg === 'upstream request failed')
  t.equal(failed.err.code, 'ESYNC')
  t.equal(failed.err.statusCode, 502)
  t.equal(failed.err.req.headers.authorization, '[redacted]')
  t.equal(failed.err.res.headers['set-cookie'], '[redacted]')
  t.equal(failed.err.body, '[redacted]')
  t.notMatch(capture.output(), /sync-request-secret/)
  t.notMatch(capture.output(), /sync-response-secret/)
  t.notMatch(capture.output(), /sync-body-secret/)
  t.notMatch(capture.output(), /nested-arbitrary-secret/)
  t.end()
})
