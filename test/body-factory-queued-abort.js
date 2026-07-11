import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'
import { request } from '../lib/request.js'

test('queued request abort promptly releases its body factory', async (t) => {
  const dispatched = []
  let firstDispatchedResolve
  const firstDispatched = new Promise((resolve) => {
    firstDispatchedResolve = resolve
  })
  const innerDispatch = (opts, handler) => {
    dispatched.push({ opts, handler })

    if (dispatched.length === 1) {
      firstDispatchedResolve()
      return
    }

    handler.onConnect((reason) => {
      queueMicrotask(() => handler.onError(reason))
    })
  }
  const dispatch = compose(
    innerDispatch,
    interceptors.priority(),
    interceptors.requestBodyFactory(),
  )
  const common = {
    origin: 'http://queued.test',
    path: '/',
    priority: 'high',
  }

  const releaseReason = new Error('release occupied priority slot')
  const firstResult = request(dispatch, { ...common, method: 'GET' }).catch((err) => err)
  await firstDispatched

  const controller = new AbortController()
  const abortReason = new Error('abort while queued')
  const factoryBody = new PassThrough().on('error', () => {})
  let factorySignal
  let factoryStartedResolve
  const factoryStarted = new Promise((resolve) => {
    factoryStartedResolve = resolve
  })
  const secondResult = request(dispatch, {
    ...common,
    method: 'PUT',
    signal: controller.signal,
    body({ signal }) {
      factorySignal = signal
      factoryStartedResolve()
      return factoryBody
    },
  }).catch((err) => err)

  await factoryStarted
  await tick()
  t.equal(dispatched.length, 1, 'the body factory starts while its attempt remains queued')

  controller.abort(abortReason)
  await tick()

  t.equal(dispatched.length, 1, 'the queue has not drained')
  t.equal(factorySignal.aborted, true, 'the factory signal aborts before dispatch')
  t.equal(factorySignal.reason, abortReason, 'the exact request abort reason is preserved')
  t.equal(factoryBody.destroyed, true, 'the factory result is released before dispatch')
  t.equal(factoryBody.errored, abortReason, 'the result is destroyed with the abort reason')

  dispatched[0].handler.onError(releaseReason)

  t.equal(await firstResult, releaseReason, 'the occupying request is released')
  t.equal(await secondResult, abortReason, 'the queued request later settles with its abort reason')
  t.equal(dispatched.length, 2, 'the queued attempt only reaches dispatch after release')
})

test('completed factory body removes its request abort listener', async (t) => {
  const signal = Object.assign(new EventEmitter(), { aborted: false, reason: undefined })
  let body
  const dispatch = interceptors.requestBodyFactory()((opts) => {
    body = opts.body
  })

  dispatch({ body: () => 'complete', signal }, {})

  t.equal(signal.listenerCount('abort'), 1, 'watches the request while the body is active')

  const chunks = []
  for await (const chunk of body) {
    chunks.push(chunk)
  }

  t.equal(Buffer.concat(chunks).toString(), 'complete')
  t.equal(signal.listenerCount('abort'), 0, 'removes the listener when the body ends')
})

test('body factory supports EventEmitter-like signals with on/off', async (t) => {
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: undefined,
    on(event, listener) {
      t.equal(event, 'abort')
      listeners.add(listener)
    },
    off(event, listener) {
      t.equal(event, 'abort')
      listeners.delete(listener)
    },
  }
  let body
  const dispatch = interceptors.requestBodyFactory()((opts) => {
    body = opts.body
  })

  t.doesNotThrow(() => dispatch({ body: () => 'complete', signal }, {}))
  t.equal(listeners.size, 1, 'subscribes through on()')

  await body.toArray()

  t.equal(listeners.size, 0, 'unsubscribes through off()')
})
