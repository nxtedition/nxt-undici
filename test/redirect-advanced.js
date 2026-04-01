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
