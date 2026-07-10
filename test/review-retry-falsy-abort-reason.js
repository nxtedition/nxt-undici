import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

for (const reason of [false, 0, '']) {
  test(`retry delivers onError after abort(${JSON.stringify(reason)})`, async (t) => {
    let abortRequest
    let attempts = 0
    const dispatch = compose((opts, handler) => {
      attempts++
      handler.onConnect(() => {})
      handler.onHeaders(503, { 'retry-after': '30' }, () => {})
      handler.onComplete({})
    }, interceptors.responseRetry())

    const error = new Promise((resolve, reject) => {
      dispatch(
        {
          origin: 'http://example.test',
          path: '/',
          method: 'GET',
          headers: {},
          retry: { count: 1 },
        },
        {
          onConnect(abort) {
            abortRequest = abort
          },
          onHeaders() {
            reject(new Error('aborted response must not be replayed'))
          },
          onData() {},
          onComplete() {
            reject(new Error('aborted response must not complete'))
          },
          onError: resolve,
        },
      )
      abortRequest(reason)
    })

    let timeoutId
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error('retry did not deliver a terminal error')), 500)
    })
    const delivered = await Promise.race([error, timeout]).finally(() => clearTimeout(timeoutId))

    t.equal(delivered, reason, 'the original abort reason is preserved')
    t.equal(attempts, 1, 'abort did not start another attempt')
  })
}
