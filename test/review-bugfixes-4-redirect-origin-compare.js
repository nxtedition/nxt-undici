import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

// ---------------------------------------------------------------------------
// Regression: redirect.js compared the caller-configured `opts.origin` against
// the WHATWG-normalized origin of the parsed Location URL with a RAW string
// comparison. A trailing slash (`http://host:port/`), an explicit default port
// (`http://host:80`) or an uppercase host made a SAME-origin redirect look
// cross-origin, so authorization/cookie were stripped and authenticated
// redirect flows broke with a 401. Both sides must be normalized before
// comparing.
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

test('redirect: trailing-slash origin keeps same-origin auth headers', async (t) => {
  t.plan(3)
  let authOnRedirect = null
  let cookieOnRedirect = null
  let hop = 0
  const server = await startServer((req, res) => {
    hop++
    if (hop === 1) {
      res.writeHead(301, { location: '/dest' })
      res.end()
    } else {
      authOnRedirect = req.headers.authorization
      cookieOnRedirect = req.headers.cookie
      res.writeHead(200)
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    // NOTE: trailing slash — normalizes to the same origin as the Location URL.
    origin: `http://127.0.0.1:${server.address().port}/`,
    path: '/start',
    method: 'GET',
    headers: { authorization: 'Bearer secret', cookie: 'session=abc' },
    follow: 5,
  })
  t.equal(status, 200)
  t.equal(authOnRedirect, 'Bearer secret', 'authorization preserved for same-origin redirect')
  t.equal(cookieOnRedirect, 'session=abc', 'cookie preserved for same-origin redirect')
})

test('redirect: uppercase-host origin keeps same-origin auth headers', async (t) => {
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
    // NOTE: uppercase host — normalizes to http://localhost:PORT.
    origin: `http://LOCALHOST:${server.address().port}`,
    path: '/start',
    method: 'GET',
    headers: { authorization: 'Bearer secret' },
    follow: 5,
  })
  t.equal(status, 200)
  t.equal(authOnRedirect, 'Bearer secret', 'authorization preserved for same-origin redirect')
})

test('redirect: trailing-slash origin still strips on genuine cross-origin', async (t) => {
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
    origin: `http://127.0.0.1:${serverA.address().port}/`,
    path: '/start',
    method: 'GET',
    headers: { authorization: 'Bearer secret', cookie: 'session=abc' },
    follow: 5,
  })
  t.equal(status, 200)
})

test('redirect: URL-object opts.origin treated as same-origin', async (t) => {
  t.plan(2)
  let authOnRedirect = 'unset'
  let hop = 0
  const server = await startServer((req, res) => {
    hop++
    if (hop === 1) {
      res.writeHead(301, {
        location: `http://127.0.0.1:${server.address().port}/dest`,
      })
      res.end()
    } else {
      authOnRedirect = req.headers.authorization
      res.writeHead(200)
      res.end()
    }
  })
  t.teardown(server.close.bind(server))

  const port = server.address().port
  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  const status = await rawRequest(dispatch, {
    // NOTE: URL object, not a string — must still normalize for the compare.
    origin: new URL(`http://127.0.0.1:${port}/`),
    path: '/start',
    method: 'GET',
    headers: { authorization: 'Bearer secret' },
    follow: 5,
  })
  t.equal(status, 200)
  t.equal(authOnRedirect, 'Bearer secret', 'URL-object origin treated as same-origin')
})
