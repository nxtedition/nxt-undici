import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function proxyRequestHeaders(headers, proxy = {}) {
  let captured
  const dispatch = compose((opts, handler) => {
    captured = opts.headers
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  }, interceptors.proxy())

  dispatch(
    {
      origin: 'http://upstream.test',
      path: '/',
      method: 'GET',
      headers,
      proxy,
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

test('proxy: singleton :scheme array normalizes default ports', (t) => {
  const headers = proxyRequestHeaders({
    host: 'EXAMPLE.COM:443',
    ':authority': 'example.com',
    ':scheme': ['https'],
    'x-keep': 'yes',
  })

  t.same(headers, { 'x-keep': 'yes' })
  t.end()
})

test('proxy: empty :scheme array falls back to the socket scheme', (t) => {
  const headers = proxyRequestHeaders(
    {
      host: 'EXAMPLE.COM:443',
      ':authority': 'example.com',
      ':scheme': [],
    },
    {
      socket: {
        localAddress: '192.0.2.1',
        encrypted: true,
      },
    },
  )

  t.equal(headers.forwarded, 'by=192.0.2.1;proto=https;host="example.com"')
  t.end()
})

test('proxy: multiple :scheme values are rejected without authority fields', (t) => {
  t.throws(() => proxyRequestHeaders({ ':scheme': ['http', 'https'], 'x-keep': 'yes' }), {
    statusCode: 502,
  })
  t.end()
})
