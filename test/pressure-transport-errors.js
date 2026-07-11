import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const ORIGIN = 'http://example.test'
const handler = {}

test('pressure: transport errors remain errors after response headers', (t) => {
  t.plan(4)

  const captured = []
  const pressure = interceptors.pressure({ sampleInterval: 0 })
  t.teardown(() => pressure.close())
  const dispatch = pressure((_opts, handler) => captured.push(handler))

  const start = (statusCode) => {
    dispatch({ origin: ORIGIN, path: '/' }, handler)
    const current = captured.at(-1)
    current.onConnect(() => {})
    current.onHeaders(statusCode, {}, () => {})
    return current
  }

  start(200).onError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
  t.match(pressure.stats(ORIGIN), { completed: 1, errored: 1 }, 'reset after 200 counts')

  start(404).onError(Object.assign(new Error('timeout'), { code: 'UND_ERR_BODY_TIMEOUT' }))
  t.match(pressure.stats(ORIGIN), { completed: 2, errored: 2 }, 'timeout after 404 counts')

  start(404).onError(Object.assign(new Error('not found'), { statusCode: 404 }))
  t.match(
    pressure.stats(ORIGIN),
    { completed: 3, errored: 2 },
    'an explicitly decorated 404 remains a non-overload response error',
  )

  start(503).onError(Object.assign(new Error('unavailable'), { statusCode: 503 }))
  t.match(
    pressure.stats(ORIGIN),
    { completed: 4, errored: 3 },
    'an explicitly decorated 503 remains an overload response error',
  )
})

test('pressure: invalid error status values settle without coercion', (t) => {
  const statusCodes = [
    Symbol('status'),
    503n,
    NaN,
    Infinity,
    {
      [Symbol.toPrimitive]() {
        throw new Error('statusCode must not be coerced')
      },
    },
  ]
  t.plan(statusCodes.length * 2)

  const captured = []
  const pressure = interceptors.pressure({ sampleInterval: 0 })
  t.teardown(() => pressure.close())
  const dispatch = pressure((_opts, handler) => captured.push(handler))

  for (const [index, statusCode] of statusCodes.entries()) {
    dispatch({ origin: ORIGIN, path: '/' }, handler)
    const current = captured.at(-1)
    current.onConnect(() => {})
    const err = Object.assign(new Error('invalid status'), { statusCode })

    t.doesNotThrow(() => current.onError(err), `value ${index + 1} is not coerced`)
    t.match(
      pressure.stats(ORIGIN),
      { completed: index + 1, errored: index + 1 },
      'invalid decorated status is classified as a transport failure',
    )
  }
})
