import { test } from 'tap'
import { parseHeaders } from '../lib/utils.js'

test('parseHeaders treats prototype names as ordinary header names', (t) => {
  const fromPairs = parseHeaders(['__proto__', 'pair-proto', 'constructor', 'pair-constructor'])

  t.equal(Object.getPrototypeOf(fromPairs), Object.prototype)
  t.equal(Object.hasOwn(fromPairs, '__proto__'), true)
  t.equal(fromPairs.__proto__, 'pair-proto')
  t.equal(Object.hasOwn(fromPairs, 'constructor'), true)
  t.equal(fromPairs.constructor, 'pair-constructor')

  const source = JSON.parse('{"__proto__":"object-proto","constructor":"object-constructor"}')
  const fromObject = parseHeaders(source)

  t.equal(Object.getPrototypeOf(fromObject), Object.prototype)
  t.equal(Object.hasOwn(fromObject, '__proto__'), true)
  t.equal(fromObject.__proto__, 'object-proto')
  t.equal(Object.hasOwn(fromObject, 'constructor'), true)
  t.equal(fromObject.constructor, 'object-constructor')

  t.end()
})
