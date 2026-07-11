import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'tap'
import { Agent, compose, interceptors } from '../lib/index.js'

function dispatchAndCollectTrailers(dispatch, opts) {
  return new Promise((resolve, reject) => {
    dispatch(opts, {
      onConnect() {},
      onHeaders() {
        return true
      },
      onData() {},
      onComplete: resolve,
      onError: reject,
    })
  })
}

test('proxy: response trailers cross the same hop-by-hop boundary as headers', async (t) => {
  const dispatch = compose((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, { connection: 'X-Header-Secret' }, () => {})
    handler.onComplete({
      ':status': '200',
      Connection: ['X-Trailer-Secret', 'keep-alive'],
      forwarded: 'for=spoofed',
      host: ['first.example', 'second.example'],
      'transfer-encoding': 'chunked',
      via: 'HTTP/1.1 edge-proxy',
      'x-header-secret': 'header-nominated secret',
      'x-trailer-secret': 'trailer-nominated secret',
      'x-checksum': 'abc123',
      'x-list': ['one', 'two'],
    })
  }, interceptors.proxy())

  const trailers = await dispatchAndCollectTrailers(dispatch, {
    origin: 'http://upstream.example',
    path: '/',
    method: 'GET',
    headers: {},
    proxy: { name: 'edge-proxy' },
  })

  t.same(trailers, {
    'x-checksum': 'abc123',
    'x-list': ['one', 'two'],
  })
})

test('proxy: an absent response trailer block remains absent', async (t) => {
  const dispatch = compose((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(204, {}, () => {})
    handler.onComplete(null)
  }, interceptors.proxy())

  const trailers = await dispatchAndCollectTrailers(dispatch, {
    origin: 'http://upstream.example',
    path: '/',
    method: 'GET',
    headers: {},
    proxy: {},
  })

  t.equal(trailers, null)
})

test('proxy: real response trailers honor Connection nominations from headers', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      connection: 'keep-alive, X-Secret',
      trailer: 'X-Secret, X-Checksum',
    })
    res.write('body')
    res.addTrailers({
      'x-secret': 'must not cross the proxy',
      'x-checksum': 'abc123',
    })
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.teardown(() => server.close())

  const agent = new Agent()
  t.teardown(() => agent.close())
  const dispatch = compose(agent, interceptors.proxy())

  const trailers = await dispatchAndCollectTrailers(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    proxy: {},
  })

  t.same(trailers, { 'x-checksum': 'abc123' })
})
