import { test } from 'tap'
import { parseHeaders } from '../lib/index.js'

test('parseHeaders accepts array-of-pairs input', (t) => {
  const headers = parseHeaders([
    [Buffer.from('Set-Cookie'), Buffer.from('a=1')],
    ['set-cookie', [Buffer.from([0xe9]), 'ascii']],
    ['__proto__', 'safe'],
  ])

  t.strictSame(headers['set-cookie'], ['a=1', 'é', 'ascii'])
  t.equal(Object.hasOwn(headers, '__proto__'), true)
  t.equal(headers.__proto__, 'safe')
  t.equal(Object.getPrototypeOf(headers), Object.prototype)
  t.end()
})

test('parseHeaders rejects malformed or mixed pair arrays', (t) => {
  const expected = {
    name: 'InvalidArgumentError',
    code: 'UND_ERR_INVALID_ARG',
    message: 'headers array must contain [name, value] pairs',
  }

  t.throws(() => parseHeaders([['x-name']]), expected)
  t.throws(() => parseHeaders([['x-name', 'value', 'extra']]), expected)
  t.throws(() => parseHeaders([['x-name', 'value'], 'x-other']), expected)
  t.throws(() => parseHeaders(['x-name', 'value', ['x-other', 'other']]), expected)
  t.throws(() => parseHeaders(['x-name', 'value', ['x-other', 'other'], 'value']), expected)
  t.end()
})
