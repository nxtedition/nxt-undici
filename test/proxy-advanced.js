/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.proxy())
}

// Helper: perform a raw dispatch and collect request headers seen by the server
function requestViaDispatch(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc) {
        statusCode = sc
        return true
      },
      onData() {},
      onComplete() {
        resolve(statusCode)
      },
      onError: reject,
    })
  })
}

// ---------------------------------------------------------------------------
// Hop-by-hop headers are stripped from the proxied request
// ---------------------------------------------------------------------------

test('proxy: strips hop-by-hop headers from proxied request', async (t) => {
  // Note: undici's transport always adds its own `connection` header at the wire
  // level, so we only verify the headers that the user supplied are stripped.
  t.plan(3)
  const server = await startServer((req, res) => {
    // These user-supplied hop-by-hop headers must NOT be forwarded
    t.notOk(req.headers['keep-alive'], 'keep-alive stripped')
    t.notOk(req.headers['transfer-encoding'], 'transfer-encoding stripped')
    t.notOk(req.headers['upgrade'], 'upgrade stripped (user-supplied value)')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      'x-custom': 'preserved',
    },
    proxy: {},
  })
})

// ---------------------------------------------------------------------------
// Non-hop-by-hop headers are preserved
// ---------------------------------------------------------------------------

test('proxy: preserves non-hop-by-hop headers', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    t.equal(req.headers['x-custom'], 'value', 'custom header preserved')
    t.equal(req.headers['accept'], 'text/html', 'accept preserved')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {
      'x-custom': 'value',
      accept: 'text/html',
      connection: 'keep-alive',
    },
    proxy: {},
  })
})

// ---------------------------------------------------------------------------
// proxy:false bypasses the interceptor entirely
// ---------------------------------------------------------------------------

test('proxy: proxy:false bypasses interceptor', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const status = await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { connection: 'keep-alive' },
    proxy: false,
  })
  t.equal(status, 200)
})

// ---------------------------------------------------------------------------
// Via header is set when proxyName is provided
// ---------------------------------------------------------------------------

test('proxy: adds Via header when proxy name is set', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    t.match(req.headers['via'], /myproxy/, 'Via header includes proxy name')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    proxy: { name: 'myproxy' },
  })
})

// ---------------------------------------------------------------------------
// Content-length is NOT forwarded for non-payload methods (when proxy is active)
// ---------------------------------------------------------------------------

test('proxy: strips content-length for non-payload GET requests', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    t.notOk(req.headers['content-length'], 'content-length stripped from GET')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { 'content-length': '0' },
    proxy: {},
  })
})
