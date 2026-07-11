import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'tap'
import requestBodyFactory from '../lib/interceptor/request-body-factory.js'

test('async dispatch rejection destroys its factory body', async (t) => {
  const reason = new Error('async dispatch failed')
  const dispatch = requestBodyFactory()(async () => {
    throw reason
  })
  const inner = new PassThrough()
  let factorySignal

  const result = dispatch(
    {
      method: 'PUT',
      body: ({ signal }) => {
        factorySignal = signal
        return inner
      },
    },
    { onError() {} },
  )

  await t.rejects(result, reason, 'dispatch rejection is preserved')
  // Factory construction and deferred _destroy each run on a later tick.
  await tick()
  await tick()

  t.equal(inner.destroyed, true, 'factory-created stream was destroyed')
  t.equal(factorySignal.aborted, true, 'factory cancellation signal was aborted')
  t.equal(factorySignal.reason, reason, 'dispatch rejection is the cancellation reason')
})

test('then-only dispatch rejection destroys its factory body', async (t) => {
  const reason = new Error('thenable dispatch failed')
  let thenCalls = 0
  const thenable = {
    then(...args) {
      thenCalls++
      args[1](reason)
    },
  }
  const dispatch = requestBodyFactory()(() => thenable)
  const inner = new PassThrough()
  let factorySignal

  const result = dispatch(
    {
      method: 'PUT',
      body: ({ signal }) => {
        factorySignal = signal
        return inner
      },
    },
    { onError() {} },
  )

  t.equal(result, thenable, 'the original thenable is returned')
  await tick()
  await tick()

  t.equal(thenCalls, 1, 'the thenable rejection was observed once')
  t.equal(inner.destroyed, true, 'factory-created stream was destroyed')
  t.equal(factorySignal.aborted, true, 'factory cancellation signal was aborted')
  t.equal(factorySignal.reason, reason, 'thenable rejection is the cancellation reason')
})

test('throwing dispatch then getter destroys its factory body', async (t) => {
  const reason = new Error('then getter failed')
  let thenReads = 0
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      thenReads++
      throw reason
    },
  })
  const dispatch = requestBodyFactory()(() => thenable)
  const inner = new PassThrough()
  let factorySignal

  const result = dispatch(
    {
      method: 'PUT',
      body: ({ signal }) => {
        factorySignal = signal
        return inner
      },
    },
    { onError() {} },
  )

  t.equal(result, thenable, 'the original thenable is returned')
  await tick()
  await tick()

  t.equal(thenReads, 1, 'the throwing then getter was observed once')
  t.equal(inner.destroyed, true, 'factory-created stream was destroyed')
  t.equal(factorySignal.aborted, true, 'factory cancellation signal was aborted')
  t.equal(factorySignal.reason, reason, 'then getter error is the cancellation reason')
})

test('cleanup failure does not create an unhandled rejection', async (t) => {
  const dispatchError = new Error('async dispatch failed')
  const cleanupError = new Error('cleanup failed')
  const inner = new PassThrough()
  const unhandled = []
  let factoryBody
  let originalDestroy

  const onUnhandledRejection = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandledRejection)
  t.teardown(() => {
    process.removeListener('unhandledRejection', onUnhandledRejection)
    if (factoryBody && originalDestroy) {
      factoryBody.destroy = originalDestroy
      factoryBody.destroy()
    }
  })

  const dispatchResult = Promise.reject(dispatchError)
  const dispatch = requestBodyFactory()((opts) => {
    factoryBody = opts.body
    originalDestroy = factoryBody.destroy
    factoryBody.destroy = () => {
      throw cleanupError
    }
    return dispatchResult
  })

  const result = dispatch(
    {
      method: 'PUT',
      body: () => inner,
    },
    { onError() {} },
  )

  t.equal(result, dispatchResult, 'the original rejected promise is returned')
  await t.rejects(result, dispatchError, 'the original dispatch rejection is preserved')
  await tick()
  await tick()

  t.same(unhandled, [], 'the cleanup error was contained')
})
