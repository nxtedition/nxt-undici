import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'tap'
import responseRetry from '../lib/interceptor/response-retry.js'

const opts = {
  origin: 'http://example.test',
  path: '/',
  method: 'GET',
  headers: {},
  retry: true,
}

test('initial dispatch Promise rejection reaches onError without becoming unhandled', async (t) => {
  const reason = new Error('initial async dispatch failed')
  const unhandled = []
  const errors = []
  const onUnhandledRejection = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandledRejection)
  t.teardown(() => process.removeListener('unhandledRejection', onUnhandledRejection))

  const dispatchResult = Promise.reject(reason)
  const dispatch = responseRetry()(() => dispatchResult)
  const result = dispatch(opts, {
    onError(err) {
      errors.push(err)
    },
  })

  t.equal(result, dispatchResult, 'preserves the original dispatch return value')
  await tick()
  await tick()

  t.same(errors, [reason], 'delivers the rejection through the handler exactly once')
  t.same(unhandled, [], 'the rejected dispatch Promise was observed')
})

test('a rejected result does not duplicate an error already reported by the dispatcher', async (t) => {
  const reason = new Error('duplicate async dispatch failure')
  const errors = []
  const unhandled = []
  const onUnhandledRejection = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandledRejection)
  t.teardown(() => process.removeListener('unhandledRejection', onUnhandledRejection))

  const dispatch = responseRetry()((dispatchOpts, handler) => {
    handler.onError(reason)
    return Promise.reject(reason)
  })
  dispatch(
    { ...opts, retry: 0 },
    {
      onError(err) {
        errors.push(err)
      },
    },
  )

  await tick()
  await tick()

  t.same(errors, [reason], 'downstream receives one terminal error')
  t.same(unhandled, [], 'the redundant rejected Promise was still observed')
})
