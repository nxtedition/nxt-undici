import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function requestHeaders(headers, proxy) {
  let captured
  const dispatch = compose((opts, handler) => {
    captured = opts.headers
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete({})
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

function responseHeaders(headers) {
  let captured
  const dispatch = compose((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, headers, () => {})
    handler.onComplete({})
  }, interceptors.proxy())

  dispatch(
    {
      origin: 'http://upstream.test',
      path: '/',
      method: 'GET',
      headers: {},
      proxy: {},
    },
    {
      onConnect() {},
      onHeaders(_statusCode, receivedHeaders) {
        captured = receivedHeaders
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

test('proxy: OWS-only scalar Via does not create an empty list member', (t) => {
  const headers = requestHeaders({ via: ' \t ' }, { name: 'edge' })

  t.equal(headers.via, 'HTTP/1.1 edge')
  t.end()
})

test('proxy: OWS-only Via array parts do not create empty list members', (t) => {
  const headers = requestHeaders({ via: ['\t ', 'HTTP/1.1 upstream', ' \t'] }, { name: 'edge' })

  t.equal(headers.via, 'HTTP/1.1 upstream, HTTP/1.1 edge')
  t.end()
})

test('proxy: OWS-only scalar Forwarded is treated as absent', (t) => {
  const headers = requestHeaders({ forwarded: '\t \t' }, {})

  t.notOk(Object.hasOwn(headers, 'forwarded'))
  t.end()
})

test('proxy: OWS-only Forwarded array parts do not create empty list members', (t) => {
  const headers = requestHeaders(
    { forwarded: [' ', 'for=192.0.2.1', '\t'] },
    {
      socket: {
        localAddress: '192.0.2.10',
        remoteAddress: '192.0.2.20',
      },
    },
  )

  t.equal(headers.forwarded, 'for=192.0.2.1, by=192.0.2.10;for=192.0.2.20;proto=http')
  t.end()
})

test('proxy: OWS detection preserves non-string response values', (t) => {
  const via = {
    length: 1,
    toString() {
      return 'HTTP/1.1 mock'
    },
  }

  const headers = responseHeaders({ via })

  t.equal(headers.via, via)
  t.end()
})
