import { test } from 'tap'
import { compose, interceptors, parseHeaders } from '../lib/index.js'

function requestHeaders(headers) {
  let forwarded
  const dispatch = compose((opts, handler) => {
    forwarded = opts.headers
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  }, interceptors.proxy())

  dispatch(
    { origin: 'http://upstream.test', path: '/', method: 'GET', headers, proxy: {} },
    {
      onConnect() {},
      onHeaders() {
        return true
      },
      onData() {},
      onComplete() {},
      onError(err) {
        throw err
      },
    },
  )
  return forwarded
}

function responseHeaders(headers) {
  let forwarded
  const dispatch = compose((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, headers, () => {})
    handler.onComplete([])
  }, interceptors.proxy())

  dispatch(
    { origin: 'http://upstream.test', path: '/', method: 'GET', headers: {}, proxy: {} },
    {
      onConnect() {},
      onHeaders(statusCode, received) {
        forwarded = received
        return true
      },
      onData() {},
      onComplete() {},
      onError(err) {
        throw err
      },
    },
  )
  return forwarded
}

function assertSafeProtoHeader(t, headers, expected) {
  t.equal(Object.getPrototypeOf(headers), Object.prototype, 'output prototype is unchanged')
  t.ok(Object.hasOwn(headers, '__proto__'), '__proto__ remains an own header')
  t.strictSame(headers.__proto__, expected, 'header value is preserved')
  t.equal(headers['x-keep'], 'yes', 'ordinary headers are preserved')
}

test('proxy: request reduction safely preserves a repeated __proto__ header', (t) => {
  const headers = parseHeaders(['__proto__', 'first', '__proto__', 'second', 'x-keep', 'yes'])

  assertSafeProtoHeader(t, requestHeaders(headers), ['first', 'second'])
  t.end()
})

test('proxy: response reduction safely preserves a single __proto__ header', (t) => {
  const headers = parseHeaders(['__proto__', 'single', 'x-keep', 'yes'])

  assertSafeProtoHeader(t, responseHeaders(headers), 'single')
  t.end()
})
