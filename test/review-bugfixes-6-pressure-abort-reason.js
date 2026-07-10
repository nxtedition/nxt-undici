// Regression test for pressure accounting with custom client abort reasons:
// downstream aborts remain caller cancellations even when the reason is an
// ordinary Error rather than a DOM-style AbortError.
import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const ORIGIN = 'http://example.test'

test('pressure: a client abort with a custom reason is not an origin error', (t) => {
  t.plan(3)

  let wrappedHandler
  let abortRequest
  const pressure = interceptors.pressure({ sampleInterval: 0 })
  t.teardown(() => pressure.close())

  const dispatch = pressure((opts, handler) => {
    wrappedHandler = handler
    const onAbort = (reason) => {
      t.equal(reason.message, 'cancelled by caller', 'custom reason reaches the dispatcher')
    }
    handler.onConnect(onAbort)
  })

  dispatch(
    { origin: ORIGIN, path: '/', method: 'GET' },
    {
      onConnect(abort) {
        abortRequest = abort
      },
      onHeaders() {},
      onData() {},
      onComplete() {},
      onError() {},
    },
  )

  const reason = new Error('cancelled by caller')
  abortRequest(reason)
  wrappedHandler.onError(reason)

  t.match(pressure.stats(ORIGIN), { completed: 1, errored: 0 })
  t.equal(pressure.stats(ORIGIN)?.running, 0, 'the aborted request still settles the gauge')
})

test('pressure: client abort state does not leak across reconnects', (t) => {
  let wrappedHandler
  let abortRequest
  const pressure = interceptors.pressure({ sampleInterval: 0 })
  t.teardown(() => pressure.close())

  const dispatch = pressure((_opts, handler) => {
    wrappedHandler = handler
    handler.onConnect(() => {})
  })

  dispatch(
    { origin: ORIGIN, path: '/', method: 'GET' },
    {
      onConnect(abort) {
        abortRequest = abort
      },
      onHeaders() {},
      onData() {},
      onComplete() {},
      onError() {},
    },
  )

  abortRequest(new Error('first attempt cancelled'))
  wrappedHandler.onConnect(() => {})
  wrappedHandler.onError(new Error('second attempt transport failure'))

  t.match(pressure.stats(ORIGIN), { completed: 1, errored: 1, running: 0 })
  t.end()
})
