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
  const dispatch = interceptors.priority()((_request, wrapped) => {
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

test('priority: an immediately acquired dispatch preserves its Promise result', async (t) => {
  const result = Promise.resolve()
  const dispatch = interceptors.priority()((_request, wrapped) => {
    wrapped.onConnect(() => {})
    return result
  })

  t.equal(dispatch(opts, handler()), result)
  await result
})

test('priority: a queued dispatch keeps the permitted void return contract', (t) => {
  let calls = 0
  let releaseFirst
  const dispatch = interceptors.priority()((_request, wrapped) => {
    calls++
    if (calls === 1) {
      releaseFirst = () => wrapped.onConnect(() => {})
    } else {
      wrapped.onConnect(() => {})
    }
  })

  dispatch(opts, handler())
  t.equal(dispatch(opts, handler()), undefined)
  t.equal(calls, 1, 'the second dispatch is queued')

  releaseFirst()
  t.equal(calls, 2, 'the queued dispatch runs after the slot is released')
  t.end()
})

test('priority: a throwing then getter reaches onError', async (t) => {
  const failure = new Error('then getter failed')
  const thenable = Object.create(null, {
    then: {
      get() {
        throw failure
      },
    },
  })
  const dispatch = interceptors.priority()(() => thenable)

  let result
  const received = new Promise((resolve) => {
    result = dispatch(opts, handler({ onError: resolve }))
  })

  t.equal(result, thenable)
  t.equal(await received, failure)
})
