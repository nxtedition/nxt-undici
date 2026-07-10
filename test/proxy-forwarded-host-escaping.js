import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function forwardedHeader(headers) {
  let forwarded
  const base = (opts, handler) => {
    forwarded = opts.headers.forwarded
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
      proxy: {
        socket: {
          localAddress: '192.0.2.1',
          encrypted: false,
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

test('proxy: Forwarded escapes quote and backslash in Host', (t) => {
  const host = String.raw`victim";for=spoofed\suffix`

  t.equal(
    forwardedHeader({ host }),
    String.raw`by=192.0.2.1;proto=http;host="victim\";for=spoofed\\suffix"`,
  )
  t.end()
})

test('proxy: Forwarded escapes quote and backslash in :authority', (t) => {
  const authority = String.raw`victim";proto=https\suffix`

  t.equal(
    forwardedHeader({ ':authority': authority }),
    String.raw`by=192.0.2.1;proto=http;host="victim\";proto=https\\suffix"`,
  )
  t.end()
})
