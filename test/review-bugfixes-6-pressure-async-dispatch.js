import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const ORIGIN = 'http://example.test'

test('pressure: an asynchronous dispatch rejection settles the origin gauges', async (t) => {
  const failure = new Error('async dispatch failed')
  const pressure = interceptors.pressure({ sampleInterval: 0 })
  t.teardown(() => pressure.close())

  const dispatch = pressure(() => Promise.reject(failure))
  let received

  await dispatch(
    { origin: ORIGIN, path: '/', method: 'GET' },
    {
      onConnect() {},
      onHeaders() {},
      onData() {},
      onComplete() {},
      onError(err) {
        received = err
      },
    },
  )

  t.equal(received, failure, 'the rejection reaches the handler')
  t.match(pressure.stats(ORIGIN), {
    pending: 0,
    running: 0,
    completed: 1,
    errored: 1,
  })
})
