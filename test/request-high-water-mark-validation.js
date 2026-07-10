import { test } from 'tap'
import { RequestHandler } from '../lib/request.js'

test('RequestHandler rejects highWaterMark values that Node streams reject', (t) => {
  for (const highWaterMark of [NaN, Infinity, -Infinity, 1.5]) {
    t.throws(
      () => new RequestHandler({ method: 'GET', body: null, highWaterMark }, () => {}),
      { name: 'InvalidArgumentError', code: 'UND_ERR_INVALID_ARG' },
      `rejects ${highWaterMark}`,
    )
  }

  t.doesNotThrow(
    () => new RequestHandler({ method: 'GET', body: null, highWaterMark: 0 }, () => {}),
  )
  t.doesNotThrow(
    () => new RequestHandler({ method: 'GET', body: null, highWaterMark: 1 }, () => {}),
  )
  t.end()
})
