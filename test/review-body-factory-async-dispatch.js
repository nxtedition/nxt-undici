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
