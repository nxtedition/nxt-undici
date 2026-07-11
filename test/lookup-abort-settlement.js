import { getEventListeners } from 'node:events'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function withTimeout(promise) {
  const { promise: timeout, reject } = Promise.withResolvers()
  const timer = setTimeout(reject, 500, new Error('lookup abort did not settle'))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function errorHandler() {
  const { promise, resolve } = Promise.withResolvers()
  let calls = 0

  return {
    promise,
    get calls() {
      return calls
    },
    handler: {
      onError(err) {
        calls++
        resolve(err)
      },
    },
  }
}

test('lookup: abort settles an ignored lookup and prevents late dispatch', async (t) => {
  const controller = new AbortController()
  const reason = new Error('stop lookup')
  const terminal = errorHandler()
  let callback
  let dispatches = 0

  const dispatch = interceptors.lookup()(() => {
    dispatches++
  })

  const result = dispatch(
    {
      origin: 'http://service.test',
      signal: controller.signal,
      lookup(_origin, _opts, cb) {
        callback = cb
      },
    },
    terminal.handler,
  )

  await tick()
  t.equal(getEventListeners(controller.signal, 'abort').length, 1, 'abort listener installed')

  controller.abort(reason)

  t.equal(await withTimeout(terminal.promise), reason, 'exact abort reason reaches the handler')
  await result
  t.equal(dispatches, 0, 'aborted lookup never dispatches')
  t.equal(getEventListeners(controller.signal, 'abort').length, 0, 'abort listener removed')

  callback(null, 'http://late.test')
  await tick()
  t.equal(dispatches, 0, 'a late callback stays ignored')
  t.equal(terminal.calls, 1, 'terminal error is delivered once')
})

test('lookup: a pre-aborted signal skips lookup and preserves a falsy reason', async (t) => {
  const controller = new AbortController()
  controller.abort(0)
  const terminal = errorHandler()
  let lookups = 0
  let dispatches = 0

  const dispatch = interceptors.lookup()(() => {
    dispatches++
  })

  const result = dispatch(
    {
      origin: 'http://service.test',
      signal: controller.signal,
      lookup() {
        lookups++
      },
    },
    terminal.handler,
  )

  t.equal(await withTimeout(terminal.promise), 0)
  await result
  t.equal(lookups, 0, 'pre-aborted lookup has no side effects')
  t.equal(dispatches, 0)
  t.equal(terminal.calls, 1)
})

test('lookup: successful settlement removes its abort listener', async (t) => {
  const controller = new AbortController()
  let completed = 0

  const dispatch = interceptors.lookup()((_opts, handler) => {
    handler.onComplete([])
  })

  await dispatch(
    {
      origin: 'http://service.test',
      signal: controller.signal,
      lookup(origin, _opts, callback) {
        setImmediate(callback, null, origin)
      },
    },
    {
      onComplete() {
        completed++
      },
      onError(err) {
        t.threw(err)
      },
    },
  )

  t.equal(completed, 1)
  t.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
