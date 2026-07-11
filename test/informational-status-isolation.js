import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function informationalThenError(failure) {
  return (_opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(
      103,
      { link: '</early.css>; rel=preload', 'x-informational': 'early-hints' },
      () => {},
    )
    handler.onError(failure)
  }
}

test('log does not report Early Hints as the terminal response', async (t) => {
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
  const dispatch = interceptors.log()(informationalThenError(failure))
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
  t.strictSame(statuses, [103], 'still forwards the informational response')
  t.equal(failed.ures.statusCode, undefined, 'does not log 103 as a terminal status')
  t.equal(failed.ures.headers, undefined, 'does not log Early Hints as terminal headers')
  t.equal(failed.ures.timing.headers, -1, 'does not record terminal-header timing for 1xx')
})

test('response-error does not decorate a transport failure with Early Hints', async (t) => {
  const failure = new Error('connection closed before final headers')
  const dispatch = interceptors.responseError()(informationalThenError(failure))
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
  t.strictSame(statuses, [103], 'still forwards the informational response')
  t.equal(received.statusCode, undefined, 'does not decorate the error with status 103')
  t.strictSame(
    received.res,
    { statusCode: undefined, headers: null, trailers: null },
    'does not attach Early Hints response metadata',
  )
  t.equal(received.req.path, '/resource', 'still decorates request metadata')
})
