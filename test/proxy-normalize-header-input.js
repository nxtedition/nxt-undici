import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function proxyRequestHeaders(headers) {
  let captured
  const base = (opts, handler) => {
    captured = opts.headers
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  }
  const dispatch = compose(base, interceptors.proxy())

  dispatch(
    {
      origin: 'http://upstream.test',
      path: '/',
      method: 'GET',
      headers,
      proxy: {},
    },
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

  return captured
}

test('proxy: standalone composition normalizes flat-array headers', (t) => {
  const headers = proxyRequestHeaders([
    'Connection',
    'X-Per-Hop',
    'X-Per-Hop',
    'must not leak',
    'X-Keep',
    'preserved',
  ])

  t.notOk('connection' in headers, 'Connection is stripped')
  t.notOk('x-per-hop' in headers, 'Connection-nominated header is stripped')
  t.equal(headers['x-keep'], 'preserved', 'ordinary header is normalized and preserved')
  t.end()
})

test('proxy: standalone composition drops nullish object header values', (t) => {
  const headers = proxyRequestHeaders({
    'X-Null': null,
    'X-Undefined': undefined,
    'X-Keep': 'preserved',
  })

  t.notOk('x-null' in headers, 'null header is dropped')
  t.notOk('x-undefined' in headers, 'undefined header is dropped')
  t.equal(headers['x-keep'], 'preserved', 'ordinary header is normalized and preserved')
  t.end()
})
