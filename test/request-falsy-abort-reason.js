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

test('RequestHandler honors a falsy abort reason received before onConnect', (t) => {
  const controller = new AbortController()
  const handler = new RequestHandler({ method: 'GET', body: null, signal: controller.signal }, () =>
    t.fail('an aborted request must not resolve'),
  )

  controller.abort(0)

  let reason = Symbol('not called')
  handler.onConnect((value) => {
    reason = value
  })

  t.equal(reason, 0)
  t.end()
})
