import { test } from 'tap'
import {
  createTestIdRecord,
  getPassBaselineError,
  hasOwnTestId,
  selectPassBaseline,
} from '../cache-tests/runner-state.js'

const prototypeIds = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']

test('cache-test ID records accept Object.prototype names', (t) => {
  const results = createTestIdRecord()

  t.equal(Object.getPrototypeOf(results), null)
  for (const id of prototypeIds) {
    t.notOk(hasOwnTestId(results, id), `${id} starts absent`)
    results[id] = true
    t.ok(hasOwnTestId(results, id), `${id} is stored as an own property`)
    t.equal(results[id], true, `${id} remains readable by property lookup`)
  }
  t.strictSame(Object.keys(results), prototypeIds)
  t.equal(
    JSON.stringify(results),
    '{"__proto__":true,"constructor":true,"hasOwnProperty":true,"toString":true,"valueOf":true}',
  )

  t.end()
})

test('cache-test baseline lookups ignore inherited properties', (t) => {
  const emptyBaseline = JSON.parse('{}')
  for (const id of prototypeIds) {
    t.notOk(hasOwnTestId(emptyBaseline, id), `${id} is not inherited into the baseline`)
  }

  const ownBaseline = JSON.parse('{"__proto__":"known","constructor":"known","toString":"known"}')
  for (const id of ['__proto__', 'constructor', 'toString']) {
    t.ok(hasOwnTestId(ownBaseline, id), `${id} is recognized when explicitly baselined`)
  }
  t.end()
})

test('full CI requires a populated pass baseline', (t) => {
  const fullCi = { ci: true, isFullRun: true, envKey: 'default' }

  t.equal(
    getPassBaselineError({ ...fullCi, passBaseline: [] }),
    'pass-baseline.json is missing or has no "default" entries — the pass-ratchet is disabled. Regenerate it with --emit-pass-baseline.',
  )
  t.equal(getPassBaselineError({ ...fullCi, passBaseline: ['passing-test'] }), null)
  t.equal(
    getPassBaselineError({ ...fullCi, ci: false, passBaseline: [] }),
    null,
    'non-CI runs may regenerate a missing baseline',
  )
  t.equal(
    getPassBaselineError({ ...fullCi, isFullRun: false, passBaseline: [] }),
    null,
    'subset CI runs do not require a full-suite baseline',
  )
  t.equal(
    getPassBaselineError({ ...fullCi, envKey: 'heuristic', passBaseline: [] }),
    'pass-baseline.json is missing or has no "heuristic" entries — the pass-ratchet is disabled. Regenerate it with --emit-pass-baseline.',
  )
  t.equal(
    getPassBaselineError({ ...fullCi, passBaseline: {} }),
    'pass-baseline.json["default"] must be an array.',
  )
  t.equal(
    getPassBaselineError({ ...fullCi, passBaseline: null }),
    'pass-baseline.json["default"] must be an array.',
  )
  t.end()
})

test('pass baseline selection distinguishes missing and malformed shapes', (t) => {
  const baseline = ['passing-test']

  t.strictSame(selectPassBaseline({}, 'default'), [], 'a missing environment is empty')
  t.equal(selectPassBaseline({ default: baseline }, 'default'), baseline)
  t.equal(
    selectPassBaseline({ default: null }, 'default'),
    null,
    'an explicit null remains malformed instead of becoming empty',
  )

  for (const malformed of [null, [], 'baseline', 1, true]) {
    t.throws(
      () => selectPassBaseline(malformed, 'default'),
      {
        name: 'TypeError',
        message: 'pass-baseline.json must contain an object.',
      },
      `${JSON.stringify(malformed)} is not a top-level baseline object`,
    )
  }
  t.end()
})
