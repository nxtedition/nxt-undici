import { test } from 'tap'
import { RequestHandler } from '../lib/request.js'

test('RequestHandler rejects abort signals without a matching removal method', (t) => {
  t.plan(2)

  const signals = [{ addEventListener() {} }, { on() {} }]

  for (const signal of signals) {
    t.throws(
      () => new RequestHandler({ method: 'GET', body: null, signal }, () => {}),
      /signal must be an EventEmitter or EventTarget/,
    )
  }
})

test('RequestHandler supports and cleans up on/off-only abort signals', async (t) => {
  const reason = new Error('stop request')
  const { promise, resolve } = Promise.withResolvers()
  let listener
  let removals = 0

  const signal = {
    aborted: false,
    reason,
    on(event, value) {
      t.equal(event, 'abort')
      listener = value
    },
    off(event, value) {
      t.equal(event, 'abort')
      t.equal(value, listener)
      removals++
    },
  }

  new RequestHandler({ method: 'GET', body: null, signal }, resolve)

  t.type(listener, 'function')
  listener()

  t.equal(await promise.catch((err) => err), reason)
  t.equal(removals, 1)
})

test('RequestHandler cleans up generic EventTarget abort signals', async (t) => {
  const reason = new Error('stop request')
  const { promise, resolve } = Promise.withResolvers()
  let listener
  let removals = 0

  const signal = {
    aborted: false,
    reason,
    addEventListener(event, value) {
      t.equal(event, 'abort')
      listener = value
    },
    removeEventListener(event, value) {
      t.equal(event, 'abort')
      t.equal(value, listener)
      removals++
    },
  }

  new RequestHandler({ method: 'GET', body: null, signal }, resolve)

  t.type(listener, 'function')
  listener()

  t.equal(await promise.catch((err) => err), reason)
  t.equal(removals, 1)
})
