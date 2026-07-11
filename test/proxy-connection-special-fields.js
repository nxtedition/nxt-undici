import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function requestHeaders(headers, proxy) {
  let received
  const dispatch = compose((opts, handler) => {
    received = opts.headers
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  }, interceptors.proxy())

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
  return received
}

function responseHeaders(headers, proxy) {
  let received
  const dispatch = compose((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, headers, () => {})
    handler.onComplete([])
  }, interceptors.proxy())

  dispatch(
    { origin: 'http://upstream.test', path: '/', method: 'GET', headers: {}, proxy },
    {
      onConnect() {},
      onHeaders(statusCode, value) {
        received = value
        return true
      },
      onData() {},
      onComplete() {},
      onError(err) {
        throw err
      },
    },
  )
  return received
}

test('proxy: Connection-nominated provenance is replaced on requests', (t) => {
  const headers = requestHeaders(
    {
      connection: ['Forwarded', 'Via'],
      forwarded: 'for=spoofed.example',
      via: '1.1 upstream.example',
      'x-keep': 'yes',
    },
    {
      name: 'edge',
      socket: {
        localAddress: '192.0.2.1',
        remoteAddress: '198.51.100.2',
        encrypted: false,
      },
    },
  )

  t.equal(headers.forwarded, 'by=192.0.2.1;for=198.51.100.2;proto=http')
  t.equal(headers.via, 'HTTP/1.1 edge')
  t.equal(headers['x-keep'], 'yes')
  t.notOk('connection' in headers)
  t.end()
})

test('proxy: Connection-nominated Forwarded is dropped without a socket', (t) => {
  const headers = requestHeaders(
    {
      connection: 'Forwarded',
      forwarded: 'for=spoofed.example',
      'x-keep': 'yes',
    },
    true,
  )

  t.notOk('forwarded' in headers)
  t.equal(headers['x-keep'], 'yes')
  t.end()
})

test('proxy: Connection-nominated provenance is replaced on responses', (t) => {
  const headers = responseHeaders(
    {
      connection: 'Forwarded, Via',
      forwarded: 'for=spoofed.example',
      via: '1.1 upstream.example',
      'x-keep': 'yes',
    },
    { name: 'edge' },
  )

  t.notOk('forwarded' in headers)
  t.equal(headers.via, 'HTTP/1.1 edge')
  t.equal(headers['x-keep'], 'yes')
  t.notOk('connection' in headers)
  t.end()
})
