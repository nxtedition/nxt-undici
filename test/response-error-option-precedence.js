import { test } from 'tap'
import responseError from '../lib/interceptor/response-error.js'

function dispatchErrorResponse(opts) {
  let outcome
  const dispatch = responseError()((_opts, handler) => {
    handler.onConnect?.(() => {})
    handler.onHeaders(500, {}, () => {})
    handler.onComplete({})
  })

  dispatch(
    {
      origin: 'http://example.test',
      path: '/',
      method: 'GET',
      headers: {},
      ...opts,
    },
    {
      onHeaders() {
        return true
      },
      onComplete() {
        outcome = 'complete'
      },
      onError() {
        outcome = 'error'
      },
    },
  )

  return outcome
}

test('response-error gives error precedence over throwOnError', (t) => {
  t.equal(
    dispatchErrorResponse({ error: true, throwOnError: false }),
    'error',
    'the primary option enables response errors',
  )
  t.equal(
    dispatchErrorResponse({ error: false, throwOnError: true }),
    'complete',
    'the primary option disables response errors',
  )
  t.end()
})

test('response-error uses throwOnError only when error is absent', (t) => {
  t.equal(
    dispatchErrorResponse({ throwOnError: false }),
    'complete',
    'the alias can disable errors',
  )
  t.equal(dispatchErrorResponse({ throwOnError: true }), 'error', 'the alias can enable errors')
  t.equal(dispatchErrorResponse({}), 'error', 'response errors remain enabled by default')
  t.end()
})
