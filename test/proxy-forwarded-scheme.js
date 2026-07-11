import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function forwardedHeader(scheme, encrypted) {
  let forwarded
  const dispatch = compose((opts, handler) => {
    forwarded = opts.headers.forwarded
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  }, interceptors.proxy())

  dispatch(
    {
      origin: 'http://upstream.test',
      path: '/',
      method: 'GET',
      headers: scheme === undefined ? {} : { ':scheme': scheme },
      proxy: {
        socket: {
          localAddress: '192.0.2.1',
          encrypted,
        },
      },
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

  return forwarded
}

test('proxy: Forwarded proto prefers :scheme over a clear proxy socket', (t) => {
  t.equal(forwardedHeader('HTTPS', false), 'by=192.0.2.1;proto=https')
  t.end()
})

test('proxy: Forwarded proto prefers :scheme over an encrypted proxy socket', (t) => {
  t.equal(forwardedHeader('http', true), 'by=192.0.2.1;proto=http')
  t.end()
})

test('proxy: Forwarded proto falls back to the proxy socket', (t) => {
  t.equal(forwardedHeader(undefined, false), 'by=192.0.2.1;proto=http')
  t.equal(forwardedHeader(undefined, true), 'by=192.0.2.1;proto=https')
  t.end()
})

test('proxy: an invalid :scheme cannot inject Forwarded parameters', (t) => {
  t.throws(() => forwardedHeader('https;for=spoofed', false), { statusCode: 502 })
  t.end()
})
