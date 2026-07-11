import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function requestHeaders(headers, proxy = {}) {
  let captured
  const base = (opts, handler) => {
    captured = opts.headers
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  }
  const dispatch = compose(base, interceptors.proxy())
  dispatch(
    { origin: 'http://upstream.test', path: '/', method: 'GET', headers, proxy },
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

test('proxy: rejects differing Host and :authority values', (t) => {
  t.throws(
    () =>
      requestHeaders({
        host: 'public.example',
        ':authority': 'internal.example',
        ':scheme': 'https',
      }),
    { statusCode: 502 },
  )
  t.end()
})

test('proxy: accepts case and default-port equivalent authorities', (t) => {
  const https = requestHeaders(
    {
      host: 'EXAMPLE.COM:443',
      ':authority': 'example.com',
      ':scheme': 'HTTPS',
    },
    {
      socket: {
        localAddress: '192.0.2.1',
        remoteAddress: '192.0.2.2',
        encrypted: true,
      },
    },
  )
  t.match(https.forwarded, /host="example\.com"/)

  const http = requestHeaders({
    host: 'example.com:080',
    ':authority': 'EXAMPLE.COM',
    ':scheme': 'http',
  })
  t.notOk('host' in http)
  t.notOk(':authority' in http)
  t.end()
})

test('proxy: keeps non-default ports significant', (t) => {
  t.throws(
    () =>
      requestHeaders({
        host: 'example.com:8443',
        ':authority': 'example.com',
        ':scheme': 'https',
      }),
    { statusCode: 502 },
  )
  t.end()
})

test('proxy: accepts equivalent bracketed IPv6 authorities', (t) => {
  const headers = requestHeaders({
    host: '[2001:0DB8::1]:443',
    ':authority': '[2001:db8::1]',
    ':scheme': 'https',
  })

  t.notOk('host' in headers)
  t.notOk(':authority' in headers)
  t.end()
})

test('proxy: rejects invalid authorities even when their strings match', (t) => {
  for (const authority of ['user@example.com', 'example.com:99999', 'example.com/path']) {
    t.throws(
      () =>
        requestHeaders({
          host: authority,
          ':authority': authority,
          ':scheme': 'https',
        }),
      { statusCode: 502 },
      authority,
    )
  }
  t.end()
})
