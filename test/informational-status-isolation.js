import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function previousResponseThenInformationalError(failure) {
  return (_opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, { 'x-attempt': 'previous' }, () => {})
    // response-retry can reuse outer handlers for a body-resume attempt without
    // forwarding that attempt's onConnect, while still forwarding its 1xx.
    handler.onHeaders(
      103,
      { link: '</early.css>; rel=preload', 'x-informational': 'early-hints' },
      () => {},
    )
    handler.onError(failure)
  }
}

test('log clears a previous attempt when Early Hints precede a failure', async (t) => {
  const failure = new Error('connection closed before final headers')
  const errorRecords = []
  const logger = {
    child() {
      return this
    },
    debug() {},
    warn() {},
    error(data, message) {
      errorRecords.push({ data, message })
    },
  }
  const dispatch = interceptors.log()(previousResponseThenInformationalError(failure))
  const statuses = []

  const received = await new Promise((resolve) => {
    dispatch(
      {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
        headers: {},
        logger,
      },
      {
        onConnect() {},
        onHeaders(statusCode) {
          statuses.push(statusCode)
          return true
        },
        onData() {},
        onComplete() {},
        onError: resolve,
      },
    )
  })

  const failed = errorRecords.find(({ message }) => message === 'upstream request failed')?.data

  t.equal(received, failure, 'forwards the original transport error')
  t.strictSame(statuses, [200, 103], 'still forwards the informational response')
  t.ok(failed, 'emits a terminal failure log')
  if (failed == null) {
    return
  }
  t.equal(failed.ures.statusCode, undefined, 'does not log 103 as a terminal status')
  t.equal(failed.ures.headers, undefined, 'does not log Early Hints as terminal headers')
  t.equal(failed.ures.timing.headers, -1, 'clears prior terminal-header timing')
})

test('response-error clears a previous attempt when Early Hints precede a failure', async (t) => {
  const failure = new Error('connection closed before final headers')
  const dispatch = interceptors.responseError()(previousResponseThenInformationalError(failure))
  const statuses = []

  const received = await new Promise((resolve) => {
    dispatch(
      {
        origin: 'http://example.test',
        path: '/resource',
        method: 'GET',
        headers: {},
      },
      {
        onConnect() {},
        onHeaders(statusCode) {
          statuses.push(statusCode)
          return true
        },
        onData() {},
        onComplete() {},
        onError: resolve,
      },
    )
  })

  t.equal(received, failure, 'keeps the original transport error')
  t.strictSame(statuses, [200, 103], 'still forwards the informational response')
  t.equal(received.statusCode, undefined, 'does not decorate the error with status 103')
  t.strictSame(
    received.res,
    { statusCode: undefined, headers: null, trailers: null },
    'does not attach Early Hints response metadata',
  )
  t.equal(received.req.path, '/resource', 'still decorates request metadata')
})
