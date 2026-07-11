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

  return captured
}

test('proxy: singleton Host array is one field value', (t) => {
  const headers = proxyRequestHeaders({ host: ['example.test'] })

  t.equal(headers.forwarded, 'by=192.0.2.1;proto=http;host="example.test"')
  t.end()
})

test('proxy: empty Host array is absent', (t) => {
  const headers = proxyRequestHeaders({ host: [] })

  t.equal(headers.forwarded, 'by=192.0.2.1;proto=http')
  t.end()
})

test('proxy: singleton :authority array is one field value', (t) => {
  const headers = proxyRequestHeaders({ ':authority': ['example.test'] })

  t.equal(headers.forwarded, 'by=192.0.2.1;proto=http;host="example.test"')
  t.end()
})

test('proxy: empty :authority array is absent', (t) => {
  const headers = proxyRequestHeaders({ ':authority': [] })

  t.equal(headers.forwarded, 'by=192.0.2.1;proto=http')
  t.end()
})

test('proxy: multiple Host array values are rejected', (t) => {
  t.throws(() => proxyRequestHeaders({ host: ['one.test', 'two.test'] }), { statusCode: 502 })
  t.end()
})

test('proxy: multiple :authority array values are rejected', (t) => {
  t.throws(() => proxyRequestHeaders({ ':authority': ['one.test', 'two.test'] }), {
    statusCode: 502,
  })
  t.end()
})

test('proxy: case-variant Host fields remain duplicates', (t) => {
  t.throws(() => proxyRequestHeaders({ Host: ['one.test'], host: ['two.test'] }), {
    statusCode: 502,
  })
  t.end()
})

test('proxy: an empty Host array does not create a duplicate', (t) => {
  const headers = proxyRequestHeaders({ Host: [], host: ['example.test'] })

  t.equal(headers.forwarded, 'by=192.0.2.1;proto=http;host="example.test"')
  t.end()
})
