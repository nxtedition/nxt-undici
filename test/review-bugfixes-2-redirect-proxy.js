/* eslint-disable */
// Regression tests for redirect and proxy bugs from the second in-depth review:
// follow:true / follow-function paths, and proxy Forwarded/Via/Connection
// handling on the response path.
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

function rawRequest(dispatch, opts) {
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
// redirect: follow: true means "follow redirects", not "reject the first one".
// ---------------------------------------------------------------------------

test('redirect: follow:true follows a 307 -> 200 chain', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(307, { location: '/final' })
      res.end()
    } else {
      res.writeHead(200)
      res.end('ok')
    }
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/start',
    method: 'GET',
    headers: {},
    follow: true,
  })
  t.equal(status, 200, 'follow:true followed the redirect instead of throwing')
})

// ---------------------------------------------------------------------------
// redirect: a follow function returning true follows; its own count logic stops.
// ---------------------------------------------------------------------------

test('redirect: follow function returning true follows then stops', async (t) => {
  t.plan(2)
  let hops = 0
  const server = await startServer((req, res) => {
    hops++
    res.writeHead(301, { location: '/next' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const seen = []
  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/start',
    method: 'GET',
    headers: {},
    follow(location, count) {
      seen.push(count)
      return count < 2
    },
  })
  t.equal(status, 301, 'delivers the 3xx once follow() returns false')
  t.ok(hops >= 2, 'at least one redirect was actually followed')
})

// ---------------------------------------------------------------------------
// proxy: Forwarded is a request-only header and must NOT be synthesized into a
// response even when proxy.socket is configured (it would leak internal addrs).
// ---------------------------------------------------------------------------

function proxyResponseHeaders(proxyOpts, responseHeaders) {
  // Stub base that drives the proxy Handler's onHeaders with a canned response.
  let received
  const base = (opts, h) => {
    h.onConnect(() => {})
    h.onHeaders(200, responseHeaders, () => {})
    h.onComplete(null)
  }
  const dispatch = compose(base, interceptors.proxy())
  return new Promise((resolve, reject) => {
    dispatch(
      { origin: 'http://up', path: '/', method: 'GET', headers: {}, proxy: proxyOpts },
      {
        onConnect() {},
        onHeaders(sc, headers) {
          received = headers
          return true
        },
        onData() {},
        onComplete() {
          resolve(received)
        },
        onError: reject,
      },
    )
  })
}

test('proxy: Forwarded is not injected into responses when socket is configured', async (t) => {
  t.plan(1)
  const received = await proxyResponseHeaders(
    {
      name: 'my-proxy',
      socket: {
        localAddress: '10.0.0.1',
        localPort: 8080,
        remoteAddress: '10.0.0.2',
        remotePort: 9090,
      },
    },
    { 'content-type': 'text/plain' },
  )
  t.notOk('forwarded' in received, 'no Forwarded header leaked downstream on the response')
})

test('proxy: an upstream-echoed Forwarded on a response is rejected (BadGateway)', async (t) => {
  t.plan(1)
  await t.rejects(
    proxyResponseHeaders(
      {
        name: 'my-proxy',
        socket: { localAddress: '10.0.0.1', localPort: 8080 },
      },
      { 'content-type': 'text/plain', forwarded: 'for=1.2.3.4' },
    ),
    /Bad Gateway/,
    'inbound Forwarded on a response is rejected',
  )
})

// ---------------------------------------------------------------------------
// proxy: a Connection-listed header is stripped regardless of key casing.
// ---------------------------------------------------------------------------

test('proxy: Connection-listed mixed-case header is stripped (request path)', (t) => {
  t.plan(2)
  let forwarded
  const base = (opts, h) => {
    forwarded = opts.headers
    h.onConnect(() => {})
    h.onHeaders(200, {}, () => {})
    h.onComplete(null)
  }
  const dispatch = compose(base, interceptors.proxy())
  dispatch(
    {
      origin: 'http://up',
      path: '/',
      method: 'GET',
      headers: { connection: 'X-Per-Hop', 'X-Per-Hop': 'leak', 'x-keep': 'yes' },
      proxy: { name: 'p' },
    },
    {
      onConnect() {},
      onHeaders() {
        return true
      },
      onData() {},
      onComplete() {
        t.notOk('X-Per-Hop' in forwarded, 'Connection-listed mixed-case header is stripped')
        t.equal(forwarded['x-keep'], 'yes', 'unrelated header is retained')
      },
      onError() {},
    },
  )
})

// ---------------------------------------------------------------------------
// proxy: an empty inbound via/forwarded must not leak downstream.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// proxy: special-header handling is case-insensitive in the standalone
// composition — a mixed-case Connection key still strips its listed per-hop
// header, and a mixed-case inbound Forwarded is still rejected.
// ---------------------------------------------------------------------------

test('proxy: mixed-case Connection key strips its listed per-hop header', (t) => {
  t.plan(2)
  let forwarded
  const base = (opts, h) => {
    forwarded = opts.headers
    h.onConnect(() => {})
    h.onHeaders(200, {}, () => {})
    h.onComplete(null)
  }
  const dispatch = compose(base, interceptors.proxy())
  dispatch(
    {
      origin: 'http://up',
      path: '/',
      method: 'GET',
      headers: { Connection: 'X-Per-Hop', 'X-Per-Hop': 'leak', 'x-keep': 'yes' },
      proxy: { name: 'p' },
    },
    {
      onConnect() {},
      onHeaders() {
        return true
      },
      onData() {},
      onComplete() {
        t.notOk('X-Per-Hop' in forwarded, 'per-hop header stripped via a mixed-case Connection key')
        t.equal(forwarded['x-keep'], 'yes', 'unrelated header retained')
      },
      onError() {},
    },
  )
})

test('proxy: mixed-case inbound Forwarded (no socket) is rejected as BadGateway', (t) => {
  t.plan(1)
  const base = (opts, h) => {
    h.onConnect(() => {})
    h.onHeaders(200, {}, () => {})
    h.onComplete(null)
  }
  const dispatch = compose(base, interceptors.proxy())
  let errored
  try {
    dispatch(
      {
        origin: 'http://up',
        path: '/',
        method: 'GET',
        headers: { Forwarded: 'for=1.2.3.4' }, // mixed-case key, no socket
        proxy: { name: 'p' },
      },
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
  } catch (err) {
    errored = err
  }
  t.match(errored?.message, /Bad Gateway/, 'mixed-case inbound Forwarded is captured and rejected')
})

test('proxy: empty via/forwarded are not emitted downstream', (t) => {
  t.plan(2)
  let forwarded
  const base = (opts, h) => {
    forwarded = opts.headers
    h.onConnect(() => {})
    h.onHeaders(200, {}, () => {})
    h.onComplete(null)
  }
  // No proxyName/socket so via is not appended and forwarded is not synthesized.
  const dispatch = compose(base, interceptors.proxy())
  dispatch(
    {
      origin: 'http://up',
      path: '/',
      method: 'GET',
      headers: { via: '', forwarded: '', 'x-keep': 'yes' },
      proxy: { name: undefined },
    },
    {
      onConnect() {},
      onHeaders() {
        return true
      },
      onData() {},
      onComplete() {
        t.notOk('via' in forwarded, 'empty via not leaked')
        t.notOk('forwarded' in forwarded, 'empty forwarded not leaked')
      },
      onError() {},
    },
  )
})
