import { test } from 'tap'
import { RequestHandler } from '../lib/request.js'

test('RequestHandler honors a pre-aborted signal with a falsy reason', (t) => {
  const controller = new AbortController()
  controller.abort(false)
  const handler = new RequestHandler({ method: 'GET', body: null, signal: controller.signal }, () =>
    t.fail('an aborted request must not resolve'),
  )

  let reason = Symbol('not called')
  handler.onConnect((value) => {
    reason = value
  })

  t.equal(reason, false)
  t.end()
})

test('RequestHandler honors a falsy abort reason received before onConnect', async (t) => {
  const controller = new AbortController()
  let settle
  const rejected = new Promise((resolve) => {
    settle = resolve
  })
  const handler = new RequestHandler(
    { method: 'GET', body: null, signal: controller.signal },
    (value) => Promise.resolve(value).catch(settle),
  )

  controller.abort(0)

  let reason = Symbol('not called')
  handler.onConnect((value) => {
    reason = value
  })

  t.equal(reason, 0)
  t.equal(await rejected, 0, 'the pending request settles with the abort reason')
})

test('RequestHandler honors null as an abort reason', async (t) => {
  const controller = new AbortController()
  let settle
  const rejected = new Promise((resolve) => {
    settle = resolve
  })
  const handler = new RequestHandler(
    { method: 'GET', body: null, signal: controller.signal },
    (value) => Promise.resolve(value).catch(settle),
  )

  controller.abort(null)

  let reason = Symbol('not called')
  handler.onConnect((value) => {
    reason = value
  })

  t.equal(reason, null)
  t.equal(await rejected, null, 'the pending request settles with the abort reason')
})
