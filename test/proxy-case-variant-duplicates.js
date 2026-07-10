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
      onError() {},
    },
  )
  return captured
}

function responseError(headers, proxy) {
  const base = (opts, handler) => {
    handler.onConnect(() => {})
    try {
      handler.onHeaders(200, headers, () => {})
      handler.onComplete([])
    } catch (err) {
      handler.onError(err)
    }
  }
  const dispatch = compose(base, interceptors.proxy())
  return new Promise((resolve, reject) => {
    dispatch(
      { origin: 'http://upstream.test', path: '/', method: 'GET', headers: {}, proxy },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          resolve(null)
        },
        onError: reject,
      },
    )
  })
}

test('proxy: case-variant Connection fields all nominate headers for removal', (t) => {
  const headers = requestHeaders({
    Connection: 'x-secret',
    connection: 'keep-alive',
    'x-secret': 'must not leak',
    'x-keep': 'preserved',
  })

  t.notOk('x-secret' in headers)
  t.equal(headers['x-keep'], 'preserved')
  t.end()
})

test('proxy: a case-variant Via field cannot hide a proxy loop', async (t) => {
  const err = await responseError(
    { Via: 'HTTP/1.1 myproxy', via: 'HTTP/1.1 benign' },
    { name: 'myproxy' },
  ).then(
    () => null,
    (err) => err,
  )

  t.equal(err?.statusCode, 508)
})

test('proxy: empty case-variant Via values do not add separators', (t) => {
  const headers = requestHeaders({ Via: '', via: 'HTTP/1.1 upstream' }, { name: 'edge' })

  t.equal(headers.via, 'HTTP/1.1 upstream, HTTP/1.1 edge')
  t.end()
})

test('proxy: case-variant duplicate Host fields are rejected', (t) => {
  t.throws(() => requestHeaders({ Host: 'one.test', host: 'two.test' }), { statusCode: 502 })
  t.end()
})

test('proxy: case-variant Forwarded fields are both retained when appending', (t) => {
  const headers = requestHeaders(
    { Forwarded: 'for=192.0.2.1', forwarded: 'for=192.0.2.2' },
    {
      socket: {
        localAddress: '192.0.2.10',
        remoteAddress: '192.0.2.20',
      },
    },
  )

  t.match(headers.forwarded, /for=192\.0\.2\.1, for=192\.0\.2\.2, by=192\.0\.2\.10/)
  t.end()
})

test('proxy: empty case-variant Forwarded values do not add separators', (t) => {
  const headers = requestHeaders(
    { Forwarded: 'for=192.0.2.1', forwarded: '' },
    {
      socket: {
        localAddress: '192.0.2.10',
        remoteAddress: '192.0.2.20',
      },
    },
  )

  t.match(headers.forwarded, /^for=192\.0\.2\.1, by=192\.0\.2\.10/)
  t.end()
})
