import { test } from 'tap'
import { makeKey } from '../lib/interceptor/cache/store.js'

const base = {
  origin: 'https://example.test',
  method: 'GET',
}

test('cache key owns origin, method and root-path normalization', (t) => {
  const opaqueOrigin = {
    [Symbol.toPrimitive]() {
      return 'opaque-cache-origin'
    },
    toString() {
      throw new Error('String(origin) must honor the primitive conversion hook')
    },
  }

  const key = makeKey({ ...base, origin: opaqueOrigin })

  t.equal(key.origin, 'opaque-cache-origin', 'origin is stringified before normalization')
  t.equal(key.method, 'GET')
  t.equal(makeKey({ ...base, method: undefined }).method, 'GET', 'bodyless method defaults to GET')
  t.equal(
    makeKey({ ...base, method: undefined, body: 'payload' }).method,
    'POST',
    'body-bearing method defaults to POST',
  )
  t.equal(key.path, '/', 'missing path defaults to the root path')
  t.equal(Object.getPrototypeOf(key.headers), null, 'even an empty header map is prototype-safe')
  t.end()
})

test('cache key normalizes flat, object and iterable headers identically', (t) => {
  const objectHeaders = Object.create(null)
  objectHeaders['X-Test'] = 'one'
  objectHeaders['x-test'] = 'two'
  objectHeaders['__proto__'] = 'safe'
  objectHeaders['x-null'] = null
  objectHeaders['x-number'] = 1

  const inputs = [
    ['X-Test', 'one', 'x-test', 'two', '__proto__', 'safe', 'x-null', null, 'x-number', 1],
    objectHeaders,
    new Map([
      ['X-Test', 'one'],
      ['x-test', 'two'],
      ['__proto__', 'safe'],
      ['x-null', null],
      ['x-number', 1],
    ]),
  ]

  for (const headers of inputs) {
    const key = makeKey({ ...base, headers })
    t.equal(Object.getPrototypeOf(key.headers), null)
    t.strictSame(key.headers['x-test'], ['one', 'two'])
    t.equal(key.headers['__proto__'], 'safe')
    t.equal(key.headers['x-number'], '1')
    t.notOk(Object.hasOwn(key.headers, 'x-null'))
    t.strictSame(Object.keys(key.headers), ['x-test', '__proto__', 'x-number'])
  }

  t.equal(objectHeaders['X-Test'], 'one', 'object input is not mutated')
  t.equal(objectHeaders['x-test'], 'two', 'normalization does not rewrite the input')
  t.equal(Object.getPrototypeOf(objectHeaders), null, 'normalization preserves the input prototype')
  t.end()
})

test('cache key preserves duplicate flat header values', (t) => {
  const key = makeKey({
    ...base,
    headers: ['X-Test', 'one', 'x-test', 'two'],
  })

  t.strictSame(key.headers['x-test'], ['one', 'two'])
  t.end()
})

test('cache key ignores an iterator polluted onto Object.prototype', (t) => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, Symbol.iterator)
  t.teardown(() => {
    if (original === undefined) {
      delete Object.prototype[Symbol.iterator]
    } else {
      Object.defineProperty(Object.prototype, Symbol.iterator, original)
    }
  })

  Object.defineProperty(Object.prototype, Symbol.iterator, {
    configurable: true,
    value: function pollutedIterator() {
      throw new Error('polluted iterator must not run')
    },
  })

  const key = makeKey({ ...base, headers: { 'X-Test': 'one' } })
  t.equal(key.headers['x-test'], 'one')
  t.equal(Object.getPrototypeOf(key.headers), null)
  t.end()
})

test('cache key retains iterable entry-shape validation', (t) => {
  const malformedIterable = {
    *[Symbol.iterator]() {
      yield ['x-test']
    },
  }

  t.throws(
    () => makeKey({ ...base, headers: malformedIterable }),
    /opts\.headers is not a valid header map/,
  )
  t.throws(() => makeKey({ ...base, headers: 'x-test: one' }), /opts\.headers is not an object/)
  t.end()
})
