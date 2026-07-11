import { getEventListeners } from 'node:events'
import { test } from 'tap'
import { RequestHandler, request } from '../lib/request.js'

test('cross-realm AbortSignal reaches transport past stopImmediatePropagation', async (t) => {
  const controller = new AbortController()
  const foreignPrototype = Object.create(EventTarget.prototype)
  Object.defineProperties(foreignPrototype, Object.getOwnPropertyDescriptors(AbortSignal.prototype))
  Object.setPrototypeOf(controller.signal, foreignPrototype)

  const reason = new Error('user abort')
  let transportReason

  t.notOk(controller.signal instanceof AbortSignal, 'signal has a foreign-realm prototype')
  controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation())

  const result = request(
    (_opts, handler) => {
      handler.onConnect((abortReason) => {
        transportReason = abortReason
        handler.onError(abortReason)
      })
    },
    'http://example.test',
    { method: 'GET', signal: controller.signal },
  )

  controller.abort(reason)

  await t.rejects(result, reason)
  t.equal(transportReason, reason, 'transport receives the original abort reason')
})

test('AbortSignal listener disposable is cleaned up on request error', (t) => {
  const controller = new AbortController()
  const reason = new Error('dispatch failed')
  const handler = new RequestHandler(
    { method: 'GET', body: null, signal: controller.signal },
    (result) => void result.catch(() => {}),
  )

  t.equal(getEventListeners(controller.signal, 'abort').length, 1, 'listener is installed')

  handler.onError(reason)

  t.equal(getEventListeners(controller.signal, 'abort').length, 0, 'listener is disposed')
  t.end()
})

test('generic EventTarget abort compatibility is retained', (t) => {
  const signal = new EventTarget()
  const handler = new RequestHandler(
    { method: 'GET', body: null, signal },
    (result) => void result.catch(() => {}),
  )
  let transportReason

  handler.onConnect((reason) => {
    transportReason = reason
  })
  signal.dispatchEvent(new Event('abort'))

  t.equal(transportReason?.code, 'UND_ERR_ABORTED', 'generic abort reaches transport')

  handler.onError(transportReason)

  t.equal(getEventListeners(signal, 'abort').length, 0, 'generic listener is removed')
  t.end()
})
