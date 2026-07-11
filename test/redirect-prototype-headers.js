import { test } from 'tap'
import redirect from '../lib/interceptor/redirect.js'

function followRedirect(headers, location = '/redirected') {
  let attempts = 0
  let redirectedHeaders

  const dispatch = redirect()((opts, handler) => {
    attempts++
    handler.onConnect(() => {})

    if (attempts === 1) {
      handler.onHeaders(307, { location }, () => {})
      handler.onComplete({})
    } else {
      redirectedHeaders = opts.headers
      handler.onHeaders(200, {}, () => {})
      handler.onComplete({})
    }
  })

  return new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://source.test',
        path: '/start',
        method: 'GET',
        headers,
        follow: 1,
      },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onComplete() {
          resolve({ attempts, headers: redirectedHeaders })
        },
        onError: reject,
      },
    )
  })
}

test('redirect preserves repeated __proto__ and constructor headers safely', async (t) => {
  const result = await followRedirect([
    '__proto__',
    'first',
    '__proto__',
    'second',
    'constructor',
    'ctor',
    'host',
    'spoofed.test',
    'x-keep',
    'yes',
  ])

  t.equal(result.attempts, 2)
  t.equal(Object.getPrototypeOf(result.headers), Object.prototype)
  t.equal(Object.hasOwn(result.headers, '__proto__'), true)
  t.strictSame(result.headers.__proto__, ['first', 'second'])
  t.equal(Object.hasOwn(result.headers, 'constructor'), true)
  t.equal(result.headers.constructor, 'ctor')
  t.equal(Object.hasOwn(result.headers, 'host'), false, 'redirect still strips Host')
  t.equal(result.headers['x-keep'], 'yes')
})

test('cross-origin redirect strips credentials without dropping scalar __proto__', async (t) => {
  const source = JSON.parse(
    '{"__proto__":"single","constructor":"ctor","authorization":"secret","cookie":"session","host":"spoofed.test","x-keep":"yes"}',
  )
  const result = await followRedirect(source, 'http://other.test/redirected')

  t.equal(result.attempts, 2)
  t.equal(Object.getPrototypeOf(result.headers), Object.prototype)
  t.equal(Object.hasOwn(result.headers, '__proto__'), true)
  t.equal(result.headers.__proto__, 'single')
  t.equal(result.headers.constructor, 'ctor')
  t.equal(Object.hasOwn(result.headers, 'authorization'), false)
  t.equal(Object.hasOwn(result.headers, 'cookie'), false)
  t.equal(Object.hasOwn(result.headers, 'host'), false)
  t.equal(result.headers['x-keep'], 'yes')
})
