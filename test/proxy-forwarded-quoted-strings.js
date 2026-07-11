import { once } from 'node:events'
import { createServer } from 'node:http'
import net from 'node:net'
import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

const socket = {
  localAddress: '192.0.2.1',
  remoteAddress: '198.51.100.2',
  encrypted: false,
}

function proxyRequestHeaders(forwarded) {
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
      headers: { forwarded },
      proxy: { socket },
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

test('proxy: rejects an unterminated Forwarded quoted-string', (t) => {
  t.throws(() => proxyRequestHeaders('for="unterminated'), { statusCode: 502 })
  t.end()
})

test('proxy: rejects a dangling quoted-pair in Forwarded', (t) => {
  t.throws(() => proxyRequestHeaders('for="dangling\\'), { statusCode: 502 })
  t.end()
})

test('proxy: preserves valid quoted commas and quoted-pairs in Forwarded', (t) => {
  const forwarded = 'for="comma, quote\\" and slash\\\\";proto=https'
  const headers = proxyRequestHeaders(forwarded)

  t.equal(headers.forwarded, `${forwarded}, by=192.0.2.1;for=198.51.100.2;proto=http`)
  t.end()
})

test('proxy: Node-accepted malformed Forwarded fails before upstream dispatch', async (t) => {
  let receivedForwarded
  let upstreamDispatches = 0
  const dispatch = compose((opts, handler) => {
    upstreamDispatches++
    handler.onConnect(() => {})
    handler.onHeaders(204, {}, () => {})
    handler.onComplete([])
  }, interceptors.proxy())

  const server = createServer((req, res) => {
    receivedForwarded = req.headers.forwarded
    try {
      dispatch(
        {
          origin: 'http://upstream.test',
          path: req.url,
          method: req.method,
          headers: req.headers,
          proxy: { req },
        },
        {
          onConnect() {},
          onHeaders() {
            return true
          },
          onData() {},
          onComplete() {
            res.end()
          },
          onError(err) {
            throw err
          },
        },
      )
    } catch (err) {
      res.statusCode = err.statusCode ?? 500
      res.end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.teardown(() => server.close())

  const response = await new Promise((resolve, reject) => {
    let data = ''
    const client = net.connect(server.address().port, '127.0.0.1', () => {
      client.end(
        'GET / HTTP/1.1\r\nHost: public.test\r\nForwarded: for="unterminated\r\nConnection: close\r\n\r\n',
      )
    })
    client.setEncoding('utf8')
    client.on('data', (chunk) => {
      data += chunk
    })
    client.on('end', () => resolve(data))
    client.on('error', reject)
  })

  t.equal(receivedForwarded, 'for="unterminated')
  t.match(response, /^HTTP\/1\.1 502 /)
  t.equal(upstreamDispatches, 0)
})
