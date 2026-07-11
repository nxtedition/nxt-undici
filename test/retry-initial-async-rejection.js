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

test('a rejected result does not duplicate a retry already started by onError', async (t) => {
  const reason = Object.assign(new Error('duplicate async dispatch failure'), {
    code: 'ECONNRESET',
  })
  const unhandled = []
  const onUnhandledRejection = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandledRejection)
  t.teardown(() => process.removeListener('unhandledRejection', onUnhandledRejection))

  const completed = Promise.withResolvers()
  let attempts = 0
  let statusCode
  const dispatch = responseRetry()((dispatchOpts, handler) => {
    attempts++
    handler.onConnect(() => {})
    if (attempts === 1) {
      handler.onError(reason)
      return Promise.reject(reason)
    }

    handler.onHeaders(200, { 'content-length': '2' }, () => {})
    handler.onData(Buffer.from('ok'))
    handler.onComplete({})
  })
  dispatch(
    { ...opts, retry: { count: 1, maxDelay: 0 } },
    {
      onConnect() {},
      onHeaders(value) {
        statusCode = value
        return true
      },
      onData() {
        return true
      },
      onComplete() {
        completed.resolve()
      },
      onError: completed.reject,
    },
  )

  await completed.promise
  await tick()
  await tick()

  t.equal(attempts, 2, 'one initial attempt and one retry')
  t.equal(statusCode, 200)
  t.same(unhandled, [], 'the redundant rejected Promise was still observed')
})

test('a throwing then getter is observed without changing the return value', async (t) => {
  const reason = new Error('then getter failed')
  const unhandled = []
  const errors = []
  let thenReads = 0
  const onUnhandledRejection = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandledRejection)
  t.teardown(() => process.removeListener('unhandledRejection', onUnhandledRejection))

  const thenable = Object.defineProperty({}, 'then', {
    get() {
      thenReads++
      throw reason
    },
  })
  const dispatch = responseRetry()(() => thenable)
  const result = dispatch(opts, {
    onError(err) {
      errors.push(err)
    },
  })

  t.equal(result, thenable)
  await tick()
  await tick()

  t.equal(thenReads, 1)
  t.same(errors, [reason])
  t.same(unhandled, [])
})
