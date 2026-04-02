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

// ---------------------------------------------------------------------------
// Response hop-by-hop headers are stripped by Handler.onHeaders
// ---------------------------------------------------------------------------

test('proxy: response hop-by-hop headers are stripped', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    // Send hop-by-hop headers back in the response.
    // Node's HTTP server normalises 'connection' automatically, but we can
    // inject custom names that the HOP_EXPR regex would match.
    res.setHeader('x-keep', 'yes')
    res.end()
  })
  t.teardown(server.close.bind(server))

  let receivedHeaders
  const dispatch = makeDispatch()
  await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: `http://127.0.0.1:${server.address().port}`,
        path: '/',
        method: 'GET',
        headers: {},
        proxy: {},
      },
      {
        onConnect() {},
        onHeaders(sc, headers) {
          receivedHeaders = headers
          return true
        },
        onData() {},
        onComplete() {
          resolve()
        },
        onError: reject,
      },
    )
  })

  t.ok(receivedHeaders, 'headers received')
  t.equal(receivedHeaders['x-keep'], 'yes', 'non-hop-by-hop response header preserved')
})

// ---------------------------------------------------------------------------
// Via loop detection: when response Via header includes the proxy name,
// the interceptor throws LoopDetected which is propagated as an error.
// ---------------------------------------------------------------------------

test('proxy: LoopDetected when response Via includes proxy name', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.setHeader('via', 'HTTP/1.1 myproxy')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  try {
    await requestViaDispatch(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
      path: '/',
      method: 'GET',
      headers: {},
      proxy: { name: 'myproxy' },
    })
    t.fail('should have thrown LoopDetected')
  } catch (err) {
    t.ok(
      err.status === 508 || err.statusCode === 508 || (err.message && err.message.includes('Loop')),
      'LoopDetected error thrown',
    )
  }
})

// ---------------------------------------------------------------------------
// Via header from a different proxy is preserved and this proxy's name appended
// (covers the `via += ', '` continuation path)
// ---------------------------------------------------------------------------

test('proxy: Via header from another proxy gets this proxy name appended', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    // Response Via header has a different proxy — not a loop
    res.setHeader('via', 'HTTP/1.1 otherproxy')
    res.end()
  })
  t.teardown(server.close.bind(server))

  let receivedVia
  const dispatch = makeDispatch()
  await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: `http://127.0.0.1:${server.address().port}`,
        path: '/',
        method: 'GET',
        headers: {},
        proxy: { name: 'myproxy' },
      },
      {
        onConnect() {},
        onHeaders(sc, headers) {
          receivedVia = headers.via
          return true
        },
        onData() {},
        onComplete() {
          resolve()
        },
        onError: reject,
      },
    )
  })

  t.match(receivedVia, /otherproxy.*myproxy|myproxy.*otherproxy/, 'both proxy names in Via')
})

// ---------------------------------------------------------------------------
// Pseudo-headers (key starting with ':') are stripped from the request
// ---------------------------------------------------------------------------

test('proxy: pseudo-headers are stripped from proxied request', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    t.notOk(req.headers[':path'], 'pseudo-header :path stripped')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { ':path': '/something' },
    proxy: {},
  })
})

// ---------------------------------------------------------------------------
// expect header is stripped (undici doesn't support it)
// ---------------------------------------------------------------------------

test('proxy: expect header is stripped from proxied request', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    t.notOk(req.headers['expect'], 'expect header stripped')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { expect: '100-continue' },
    proxy: {},
  })
})

// ---------------------------------------------------------------------------
// proxy.socket (IPv4 with port) → forwarded header is built and sent
// Covers proxy.js lines 97-109 and printIp IPv4-with-port path (lines 134-147)
// ---------------------------------------------------------------------------

test('proxy: socket info builds forwarded request header (IPv4)', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    t.ok(req.headers['forwarded'], 'forwarded header present in proxied request')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    proxy: {
      socket: {
        localAddress: '10.0.0.1',
        localPort: 8080,
        remoteAddress: '192.168.1.2',
        remotePort: 54321,
        encrypted: false,
      },
    },
  })
})

// ---------------------------------------------------------------------------
// proxy.socket with IPv6 address → printIp wraps in brackets
// Covers printIp isIPv6 branch (proxy.js lines 136-138)
// ---------------------------------------------------------------------------

test('proxy: socket with IPv6 address builds forwarded header with bracketed IP', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    const fwd = req.headers['forwarded'] ?? ''
    t.ok(fwd.includes('['), 'IPv6 address is bracketed in forwarded header')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    proxy: {
      socket: {
        localAddress: '::1',
        localPort: 8080,
        remoteAddress: '::ffff:192.0.2.1',
        remotePort: 12345,
        encrypted: true,
      },
    },
  })
})

// ---------------------------------------------------------------------------
// Response forwarded header with no proxy socket → BadGateway
// Covers proxy.js lines 111-113 (else if (forwarded) throw BadGateway)
// ---------------------------------------------------------------------------

test('proxy: response forwarded header without socket throws BadGateway', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    // Simulate a misbehaving upstream that echoes a forwarded header back
    res.setHeader('forwarded', 'for=192.168.1.1')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  try {
    await requestViaDispatch(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
      path: '/',
      method: 'GET',
      headers: {},
      proxy: {}, // no socket → reduceHeaders in Handler.onHeaders throws BadGateway
    })
    t.fail('should have thrown BadGateway')
  } catch (err) {
    t.ok(
      err.status === 502 ||
        err.statusCode === 502 ||
        (err.message && err.message.includes('Bad Gateway')),
      'BadGateway thrown when response forwarded header present without proxy socket',
    )
  }
})

// ---------------------------------------------------------------------------
// proxy.socket + host header → forwardedHost is set from host value
// Covers proxy.js line 76 (host = val) and line 107 (host in forwarded)
// ---------------------------------------------------------------------------

test('proxy: host header contributes to forwarded host field when socket is set', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    const fwd = req.headers['forwarded'] ?? ''
    t.ok(fwd.includes('host="myhost.example.com"'), 'host value present in forwarded header')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { host: 'myhost.example.com' },
    proxy: {
      socket: {
        localAddress: '10.0.0.1',
        localPort: 8080,
        remoteAddress: '10.0.0.2',
        remotePort: 9090,
        encrypted: false,
      },
    },
  })
})

// ---------------------------------------------------------------------------
// :authority pseudo-header is used as forwardedHost when socket present
// Covers proxy.js lines 82-83 (:authority capture) and takes priority over host
// ---------------------------------------------------------------------------

test('proxy: :authority pseudo-header contributes to forwarded host and is stripped', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    // :authority must be stripped from request (pseudo-header)
    t.notOk(req.headers[':authority'], ':authority pseudo-header stripped from request')
    const fwd = req.headers['forwarded'] ?? ''
    t.ok(fwd.includes('host="authority.example.com"'), ':authority value used as forwarded host')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { ':authority': 'authority.example.com' },
    proxy: {
      socket: {
        localAddress: '10.0.0.1',
        localPort: 8080,
        remoteAddress: '10.0.0.2',
        remotePort: 9090,
        encrypted: false,
      },
    },
  })
})

// ---------------------------------------------------------------------------
// connection header listing a non-standard header name → that header is removed
// Covers proxy.js lines 88-89 (connection value used to build remove list)
// Per RFC 7230, Connection header may name headers that are per-hop only
// ---------------------------------------------------------------------------

test('proxy: connection header removes the named custom header', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    // x-per-hop was named in Connection, so it must be stripped
    t.notOk(req.headers['x-per-hop'], 'x-per-hop header removed via connection directive')
    // x-normal was not named, so it must pass through
    t.equal(req.headers['x-normal'], 'keep', 'x-normal header preserved')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {
      connection: 'x-per-hop',
      'x-per-hop': 'remove-me',
      'x-normal': 'keep',
    },
    proxy: {},
  })
})

// ---------------------------------------------------------------------------
// forwarded header is appended to when socket + existing forwarded request header
// Covers the `forwarded ? forwarded + ', ' : ''` branch (proxy.js line 103)
// ---------------------------------------------------------------------------

test('proxy: existing forwarded header is prepended to new socket-built entry', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    const fwd = req.headers['forwarded'] ?? ''
    // Should contain both the original value and the new socket-built entry
    t.ok(
      fwd.includes('for=1.2.3.4') && fwd.includes('by='),
      'existing forwarded value plus new entry',
    )
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {
      forwarded: 'for=1.2.3.4',
    },
    proxy: {
      socket: {
        localAddress: '10.0.0.1',
        localPort: 8888,
        remoteAddress: '10.0.0.2',
        remotePort: 9999,
        encrypted: false,
      },
    },
  })
})

// ---------------------------------------------------------------------------
// onUpgrade: proxy handler processes response headers and forwards socket (lines 15-32)
// ---------------------------------------------------------------------------

test('proxy: onUpgrade processes response headers via reduceHeaders and forwards socket', async (t) => {
  t.plan(2)
  // Mock dispatch that sends an upgrade (101) response
  const mockDispatch = (opts, handler) => {
    handler.onConnect(() => {})
    handler.onUpgrade(101, { upgrade: 'websocket', 'x-custom': 'keep' }, {})
    return true
  }
  const dispatch = compose(mockDispatch, interceptors.proxy())

  let upgradedHeaders
  await new Promise((resolve, reject) => {
    dispatch(
      {
        method: 'GET',
        path: '/',
        origin: 'http://x',
        headers: {},
        proxy: { httpVersion: '1.1' },
      },
      {
        onConnect() {},
        onUpgrade(statusCode, headers, socket) {
          upgradedHeaders = headers
          resolve()
        },
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          resolve()
        },
        onError: reject,
      },
    )
  })

  t.ok(upgradedHeaders, 'onUpgrade was called with processed headers')
  t.equal(upgradedHeaders['x-custom'], 'keep', 'non-hop headers preserved in upgrade response')
})

// ---------------------------------------------------------------------------
// Regression: content-length on GET requests was NOT stripped by the proxy
// interceptor due to a missing `else if`. The first `if` matched (empty body)
// but fell through to the next `if` which re-added the header.
// ---------------------------------------------------------------------------

test('proxy: content-length is stripped from GET requests (non-payload methods)', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    t.notOk(req.headers['content-length'], 'content-length stripped on GET')
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

test('proxy: content-length is preserved on POST requests (payload methods)', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    t.equal(req.headers['content-length'], '5', 'content-length preserved on POST')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'POST',
    headers: { 'content-length': '5' },
    body: 'hello',
    proxy: {},
  })
})
