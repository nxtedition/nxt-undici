import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

// Regression tests: the proxy interceptor used to call .toString() on response
// header values. Repeated field-lines arrive from parseHeaders as an ARRAY, and
// Array.prototype.toString comma-joins with no space — corrupting fields whose
// values legally contain commas and must never be combined (RFC 9110 §5.3):
// two set-cookie lines (RFC 6265) reached the client as ONE garbled cookie, and
// multiple www-authenticate challenges were mangled. Repeated headers must reach
// the client as distinct values (an array), matching what undici delivers
// without the proxy interceptor.

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.proxy())
}

// Helper: perform a raw dispatch and collect the response headers the client observes
function responseHeadersViaDispatch(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let headers
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc, h) {
        headers = h
        return true
      },
      onData() {},
      onComplete() {
        resolve(headers)
      },
      onError: reject,
    })
  })
}

// ---------------------------------------------------------------------------
// Two set-cookie field-lines must reach the client as two distinct cookies
// ---------------------------------------------------------------------------

test('proxy: repeated set-cookie response headers are preserved as distinct values', async (t) => {
  t.plan(1)
  const cookies = ['a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/', 'b=2; Path=/']
  const server = await startServer((req, res) => {
    res.setHeader('set-cookie', cookies)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const headers = await responseHeadersViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    proxy: {},
  })

  t.strictSame(headers['set-cookie'], cookies, 'both cookies received as distinct array entries')
})

// ---------------------------------------------------------------------------
// Multiple www-authenticate challenges must both be preserved
// ---------------------------------------------------------------------------

test('proxy: repeated www-authenticate response headers are preserved', async (t) => {
  t.plan(1)
  const challenges = ['Basic realm="users", charset="UTF-8"', 'Bearer realm="api"']
  const server = await startServer((req, res) => {
    res.setHeader('www-authenticate', challenges)
    res.writeHead(401)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const headers = await responseHeadersViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    proxy: {},
  })

  t.strictSame(headers['www-authenticate'], challenges, 'both challenges preserved')
})

// ---------------------------------------------------------------------------
// A repeated non-special header is preserved with both values, matching what
// undici delivers without the proxy interceptor
// ---------------------------------------------------------------------------

test('proxy: repeated custom response header matches non-proxied undici shape', async (t) => {
  t.plan(2)
  const handler = (req, res) => {
    res.setHeader('x-custom', ['1', '2'])
    res.end()
  }
  const server = await startServer(handler)
  t.teardown(server.close.bind(server))

  const origin = `http://127.0.0.1:${server.address().port}`
  const opts = { origin, path: '/', method: 'GET', headers: {} }

  // Baseline: no proxy interceptor
  const agent = new undici.Agent()
  const baseline = await responseHeadersViaDispatch((o, h) => agent.dispatch(o, h), {
    ...opts,
    proxy: false,
  })

  const proxied = await responseHeadersViaDispatch(makeDispatch(), { ...opts, proxy: {} })

  t.strictSame(baseline['x-custom'], ['1', '2'], 'baseline undici delivers both values')
  t.strictSame(proxied['x-custom'], baseline['x-custom'], 'proxied shape matches baseline')
})

// ---------------------------------------------------------------------------
// Single-valued headers keep their plain string shape (no regression)
// ---------------------------------------------------------------------------

test('proxy: single-valued response header stays a plain string', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.setHeader('x-single', 'only')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const headers = await responseHeadersViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    proxy: {},
  })

  t.equal(headers['x-single'], 'only', 'single value remains a string')
})
