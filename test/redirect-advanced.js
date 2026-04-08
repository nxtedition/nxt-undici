/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Redirect works when composed directly with Agent (non-async dispatch)
//
// Regression: redirect.js used `dispatch(...)?.catch(fn)` which crashed when
// the underlying dispatch returned a boolean (true) rather than a Promise.
// ---------------------------------------------------------------------------

test('redirect: follows 301 when composed directly with Agent (non-async dispatch)', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(301, { location: '/final' })
      res.end()
    } else {
      res.writeHead(200)
      res.end('final')
    }
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/redirect',
    method: 'GET',
    headers: {},
    follow: 5,
  })
  t.equal(status, 200)
})

test('redirect: follows 302 chain without crashing', async (t) => {
  t.plan(1)
  let hops = 0
  const server = await startServer((req, res) => {
    hops++
    if (hops < 3) {
      res.writeHead(302, { location: '/next' })
      res.end()
    } else {
      res.writeHead(200)
      res.end('done')
    }
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/start',
    method: 'GET',
    headers: {},
    follow: 5,
  })
  t.equal(status, 200)
})

test('redirect: 303 converts method to GET', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    if (req.url === '/post') {
      res.writeHead(303, { location: '/result' })
      res.end()
    } else {
      t.equal(req.method, 'GET', '303 redirect must switch method to GET')
      res.writeHead(200)
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/post',
    method: 'POST',
    headers: {},
    follow: 5,
  })
  t.equal(status, 200)
})

test('redirect: max redirect count throws', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(301, { location: '/loop' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  try {
    await rawRequest(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
      path: '/loop',
      method: 'GET',
      headers: {},
      follow: 3,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /Max redirections reached/)
  }
})

test('redirect: follow:false passthrough — non-redirect response returned as-is', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(301, { location: '/other' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    follow: false,
  })
  // follow:false → redirect handler is bypassed; 301 returned raw
  t.equal(status, 301)
})

// ---------------------------------------------------------------------------
// follow as a function: returning false stops following and delivers the
// redirect response as-is to the caller (redirect.js lines 69-73)
// ---------------------------------------------------------------------------

test('redirect: follow function returning false stops redirect and delivers 3xx response', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(301, { location: '/other' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  let followCalled = false
  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    follow(location, count, opts) {
      followCalled = true
      return false // stop redirecting
    },
  })

  t.ok(followCalled, 'follow function was called')
  t.equal(status, 301, 'redirect response delivered when follow() returns false')
})

test('redirect: user-supplied host header is stripped on redirect (undici sets its own)', async (t) => {
  t.plan(2)
  let hop = 0
  const server = await startServer((req, res) => {
    hop++
    if (hop === 1) {
      res.writeHead(301, { location: '/second' })
      res.end()
    } else {
      // undici always sets the correct host; the user-supplied value must not appear
      // as a separate header — the actual host value comes from undici's transport
      t.ok(req.headers.host, 'host header is present after redirect')
      t.notOk(req.headers.host.startsWith('override'), 'user-supplied host override is removed')
      res.writeHead(200)
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/first',
    method: 'GET',
    headers: { host: 'override.example.com' },
    follow: 5,
  })
})

// ---------------------------------------------------------------------------
// Regression: cleanRequestHeaders returned undefined when all headers were
// removed (e.g. 303 cross-origin redirect with only host + content-type).
// This caused opts.headers to be undefined, which could crash downstream
// interceptors that spread headers ({...opts.headers}).
// ---------------------------------------------------------------------------

test('redirect: 303 cross-origin strips all headers without crashing', async (t) => {
  t.plan(1)
  // Server A redirects to Server B with 303
  const serverB = await startServer((req, res) => {
    res.writeHead(200)
    res.end('final')
  })
  t.teardown(serverB.close.bind(serverB))

  const serverA = await startServer((req, res) => {
    // 303 to a different origin — removes host, content-*, authorization, cookie
    res.writeHead(303, { location: `http://127.0.0.1:${serverB.address().port}/dest` })
    res.end()
  })
  t.teardown(serverA.close.bind(serverA))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${serverA.address().port}`,
    path: '/start',
    method: 'POST',
    headers: { host: 'a.example.com', 'content-type': 'application/json' },
    follow: 5,
  })
  t.equal(status, 200, '303 cross-origin redirect succeeds without undefined headers')
})

// ---------------------------------------------------------------------------
// Cross-origin redirect strips authorization and cookie headers
// ---------------------------------------------------------------------------

test('redirect: cross-origin redirect strips authorization and cookie', async (t) => {
  t.plan(3)
  const serverB = await startServer((req, res) => {
    t.notOk(req.headers.authorization, 'authorization header must be stripped on cross-origin')
    t.notOk(req.headers.cookie, 'cookie header must be stripped on cross-origin')
    res.writeHead(200)
    res.end()
  })
  t.teardown(serverB.close.bind(serverB))

  const serverA = await startServer((req, res) => {
    res.writeHead(301, { location: `http://127.0.0.1:${serverB.address().port}/dest` })
    res.end()
  })
  t.teardown(serverA.close.bind(serverA))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${serverA.address().port}`,
    path: '/start',
    method: 'GET',
    headers: { authorization: 'Bearer secret', cookie: 'session=abc' },
    follow: 5,
  })
  t.equal(status, 200)
})

// ---------------------------------------------------------------------------
// Same-origin redirect preserves authorization header
// ---------------------------------------------------------------------------

test('redirect: same-origin redirect preserves authorization header', async (t) => {
  t.plan(2)
  let authOnRedirect = null
  let hop = 0
  const server = await startServer((req, res) => {
    hop++
    if (hop === 1) {
      res.writeHead(301, { location: '/dest' })
      res.end()
    } else {
      authOnRedirect = req.headers.authorization
      res.writeHead(200)
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/start',
    method: 'GET',
    headers: { authorization: 'Bearer secret' },
    follow: 5,
  })
  t.equal(status, 200)
  t.ok(authOnRedirect, 'authorization preserved for same-origin redirect')
})

// ---------------------------------------------------------------------------
// 307 redirect preserves method (PUT stays PUT)
// ---------------------------------------------------------------------------

test('redirect: 307 preserves original method', async (t) => {
  t.plan(2)
  let methodOnRedirect = null
  let hop = 0
  const server = await startServer((req, res) => {
    hop++
    if (hop === 1) {
      res.writeHead(307, { location: '/dest' })
      res.end()
    } else {
      methodOnRedirect = req.method
      res.writeHead(200)
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/start',
    method: 'PUT',
    headers: { 'content-length': '0' },
    follow: 5,
  })
  t.equal(status, 200)
  t.equal(methodOnRedirect, 'PUT', '307 should preserve PUT method')
})

// ---------------------------------------------------------------------------
// Missing location header on redirect throws
// ---------------------------------------------------------------------------

test('redirect: missing location header throws error', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    // 301 without location header
    res.writeHead(301)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  try {
    await rawRequest(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
      path: '/',
      method: 'GET',
      headers: {},
      follow: 5,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /Missing redirection location/)
  }
})
