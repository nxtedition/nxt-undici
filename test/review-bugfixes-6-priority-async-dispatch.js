import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const opts = {
  origin: 'http://example.test',
  path: '/',
  method: 'GET',
  headers: {},
  priority: 1,
}

function handler(overrides = {}) {
  return {
    onConnect() {},
    onHeaders() {},
    onData() {},
    onComplete() {},
    onError() {},
    ...overrides,
  }
}

test('priority: an asynchronous dispatch rejection reports onError and releases the slot', async (t) => {
  const failure = new Error('async dispatch failed')
  let calls = 0
  const dispatch = interceptors.priority()((request, wrapped) => {
    calls++
    if (calls === 1) {
      return Promise.reject(failure)
    }
    wrapped.onConnect(() => {})
    wrapped.onComplete()
    return Promise.resolve()
  })

  const received = new Promise((resolve) => {
    dispatch(opts, handler({ onError: resolve }))
  })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('onError was not delivered')), 250)
  })

  t.equal(await Promise.race([received, timeout]), failure, 'rejection reaches the handler')
  clearTimeout(timer)

  let completed = false
  dispatch(opts, handler({ onComplete: () => (completed = true) }))
  await Promise.resolve()

  t.equal(calls, 2, 'a subsequent request is dispatched')
  t.equal(completed, true, 'the released scheduler slot is reusable')
})

test('priority: a throwing onError does not create an unhandled rejection', async (t) => {
  const failure = new Error('async dispatch failed')
  let unhandled
  const onUnhandledRejection = (err) => {
    unhandled = err
  }
  process.once('unhandledRejection', onUnhandledRejection)
  t.teardown(() => process.off('unhandledRejection', onUnhandledRejection))

  const dispatch = interceptors.priority()(() => Promise.reject(failure))
  dispatch(
    opts,
    handler({
      onError() {
        throw new Error('user onError failed')
      },
    }),
  )

  await new Promise((resolve) => setImmediate(resolve))
  t.equal(unhandled, undefined)
})
