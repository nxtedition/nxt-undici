import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const MAX_TIMER_DELAY = 2 ** 31 - 1
const NUMERIC_OPTIONS = [
  'sampleInterval',
  'tau',
  'someLo',
  'someHi',
  'fullLo',
  'fullHi',
  'errLo',
  'errHi',
]

test('pressure: accepts the documented numeric option domains', (t) => {
  const pressure = interceptors.pressure({
    sampleInterval: MAX_TIMER_DELAY,
    tau: Number.MIN_VALUE,
    someLo: Number.MIN_VALUE,
    someHi: 1 - Number.EPSILON,
    fullLo: Number.MIN_VALUE,
    fullHi: 1 - Number.EPSILON,
    errLo: Number.MIN_VALUE,
    errHi: 1 - Number.EPSILON,
  })

  t.type(pressure, 'function')
  pressure.close()
  t.end()
})

test('pressure: accepts zero as manual sampling mode', (t) => {
  const pressure = interceptors.pressure({ sampleInterval: 0 })

  t.type(pressure, 'function')
  pressure.close()
  t.end()
})

test('pressure: rejects non-number numeric options', (t) => {
  t.plan(NUMERIC_OPTIONS.length)

  for (const name of NUMERIC_OPTIONS) {
    t.throws(() => interceptors.pressure({ [name]: '1' }), {
      name: 'TypeError',
      message: `opts.${name} must be a number`,
    })
  }
})

test('pressure: rejects invalid sampling ranges', (t) => {
  const cases = [
    ['sampleInterval', NaN, `a finite number from 0 through ${MAX_TIMER_DELAY}`],
    ['sampleInterval', Infinity, `a finite number from 0 through ${MAX_TIMER_DELAY}`],
    ['sampleInterval', -1, `a finite number from 0 through ${MAX_TIMER_DELAY}`],
    ['sampleInterval', MAX_TIMER_DELAY + 1, `a finite number from 0 through ${MAX_TIMER_DELAY}`],
    ['tau', NaN, 'a finite number greater than 0'],
    ['tau', Infinity, 'a finite number greater than 0'],
    ['tau', 0, 'a finite number greater than 0'],
    ['tau', -1, 'a finite number greater than 0'],
  ]
  t.plan(cases.length)

  for (const [name, value, range] of cases) {
    t.throws(() => interceptors.pressure({ [name]: value }), {
      name: 'RangeError',
      message: `opts.${name} must be ${range}`,
    })
  }
})

test('pressure: rejects non-finite and unreachable hysteresis thresholds', (t) => {
  const cases = []
  for (const name of NUMERIC_OPTIONS.slice(2)) {
    cases.push([name, NaN], [name, Infinity])
  }
  cases.push(
    ['someLo', 0],
    ['someHi', 1],
    ['fullLo', -0.1],
    ['fullHi', 1.1],
    ['errLo', 0],
    ['errHi', 1],
  )
  t.plan(cases.length)

  for (const [name, value] of cases) {
    t.throws(() => interceptors.pressure({ [name]: value }), {
      name: 'RangeError',
      message: `opts.${name} must be a finite number strictly between 0 and 1`,
    })
  }
})

test('pressure: rejects reversed or collapsed hysteresis dead-bands', (t) => {
  const cases = [
    ['some', 0.5, 0.5],
    ['some', 0.6, 0.5],
    ['full', 0.5, 0.5],
    ['full', 0.6, 0.5],
    ['err', 0.5, 0.5],
    ['err', 0.6, 0.5],
  ]
  t.plan(cases.length)

  for (const [name, lo, hi] of cases) {
    t.throws(() => interceptors.pressure({ [`${name}Lo`]: lo, [`${name}Hi`]: hi }), {
      name: 'RangeError',
      message: `opts.${name}Lo must be less than opts.${name}Hi`,
    })
  }
})
