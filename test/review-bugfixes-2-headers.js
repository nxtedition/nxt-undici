/* eslint-disable */
// Regression tests for header-shape bugs found in the second in-depth review:
// duplicate/array-valued headers and empty header values mishandled across
// response-error, response-verify, parseHeaders, the sqlite store and the
// cache Vary lookup.
import { test } from 'tap'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, compose, interceptors, parseHeaders } from '../lib/index.js'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'
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
    const chunks = []
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc) {
        statusCode = sc
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      },
      onComplete() {
        resolve({ statusCode, body: Buffer.concat(chunks).toString() })
      },
      onError: reject,
    })
  })
}

// ---------------------------------------------------------------------------
// response-error: a duplicated Content-Type header (array value) must not
// crash the decoder; the JSON error body and reason/code/error are preserved.
// ---------------------------------------------------------------------------

test('response-error: duplicate content-type still decodes the JSON error body', (t) => {
  t.plan(5)
  const server = createServer((req, res) => {
    // Flat-array writeHead emits the field twice -> undici parses it as an array.
    res.writeHead(503, ['content-type', 'application/json', 'content-type', 'application/json'])
    res.end(JSON.stringify({ reason: 'boom', code: 'EBOOM', error: 'failure' }))
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      // retry:false — 503 is otherwise retried 8x with backoff (~28s).
      await request(`http://0.0.0.0:${server.address().port}`, { retry: false })
      t.fail('should have rejected')
    } catch (err) {
      t.notOk(/startsWith is not a function/.test(err.message), 'not a TypeError')
      t.equal(err.statusCode, 503)
      t.equal(err.reason, 'boom')
      t.equal(err.code, 'EBOOM')
      t.equal(err.error, 'failure')
    }
  })
})

// ---------------------------------------------------------------------------
// response-verify: two identical Content-MD5 headers (a CDN re-appending its
// own) describe the same digest and must not produce a false mismatch; two
// conflicting ones must still be rejected.
// ---------------------------------------------------------------------------

function driveVerify(headers, body) {
  const base = (opts, h) => {
    h.onConnect(() => {})
    h.onHeaders(200, headers, () => {})
    h.onData(Buffer.from(body))
    h.onComplete(null)
  }
  const dispatch = compose(base, interceptors.responseVerify())
  return new Promise((resolve) => {
    dispatch(
      { origin: 'http://x', path: '/', method: 'GET', headers: {}, verify: { hash: true } },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          resolve('complete')
        },
        onError(err) {
          resolve(err)
        },
      },
    )
  })
}

test('response-verify: duplicate identical content-md5 is accepted', async (t) => {
  t.plan(1)
  const body = 'hello world'
  const md5 = crypto.createHash('md5').update(body).digest('base64')
  const result = await driveVerify({ 'content-md5': [md5, md5] }, body)
  t.equal(result, 'complete', 'identical duplicate Content-MD5 does not cause a false mismatch')
})

test('response-verify: conflicting duplicate content-md5 is rejected', async (t) => {
  t.plan(1)
  const body = 'hello world'
  const md5 = crypto.createHash('md5').update(body).digest('base64')
  const result = await driveVerify({ 'content-md5': [md5, 'AAAAAAAAAAAAAAAAAAAAAA=='] }, body)
  t.ok(result instanceof Error, 'conflicting Content-MD5 values are still rejected')
})

// ---------------------------------------------------------------------------
// parseHeaders: an empty-string first value is a present header and must not
// be dropped when a duplicate occurrence arrives.
// ---------------------------------------------------------------------------

test('parseHeaders: empty-string value is preserved across a duplicate header', (t) => {
  t.plan(1)
  const out = parseHeaders(['x-dup', '', 'x-dup', 'value'])
  t.same(out, { 'x-dup': ['', 'value'] }, 'first empty value not clobbered by the duplicate')
})

// ---------------------------------------------------------------------------
// sqlite store: a vary value stored as a scalar must still match its
// single-element array form (and vice versa) — no avoidable cache miss.
// ---------------------------------------------------------------------------

test('sqlite store: vary scalar matches single-element array form', (t) => {
  t.plan(2)
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  const now = Date.now()
  const value = {
    body: Buffer.from('x'),
    start: 0,
    end: 1,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    deleteAt: now + 7200e3,
    vary: { 'accept-encoding': 'gzip' }, // stored as scalar
  }
  store.set(
    { origin: 'https://e.com', method: 'GET', path: '/a', headers: { 'accept-encoding': 'gzip' } },
    value,
  )
  // Requested as a single-element array -> must still hit.
  const hit = store.get({
    origin: 'https://e.com',
    method: 'GET',
    path: '/a',
    headers: { 'accept-encoding': ['gzip'] },
  })
  t.ok(hit, 'scalar-stored vary matches array-form request header')

  // Reverse: store as array, request as scalar.
  store.set(
    {
      origin: 'https://e.com',
      method: 'GET',
      path: '/b',
      headers: { 'accept-encoding': ['gzip'] },
    },
    { ...value, vary: { 'accept-encoding': ['gzip'] } },
  )
  const hit2 = store.get({
    origin: 'https://e.com',
    method: 'GET',
    path: '/b',
    headers: { 'accept-encoding': 'gzip' },
  })
  t.ok(hit2, 'array-stored vary matches scalar request header')
})

// ---------------------------------------------------------------------------
// cache: Vary matching must be case-insensitive against request header names,
// so a non-lowercase selecting header does not serve the wrong variant.
// ---------------------------------------------------------------------------

test('cache: Vary lookup is case-insensitive (no wrong-variant serve)', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, {
      'cache-control': 's-maxage=60',
      vary: 'accept',
      'content-type': 'text/plain',
    })
    res.end(`accept=${req.headers.accept ?? ''}`)
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = compose(new undici.Agent(), interceptors.cache())
  const base = {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    cache: { store },
  }

  // First request with a mixed-case selecting header name.
  await rawRequest(dispatch, { ...base, headers: { Accept: 'text/html' } })
  // Second request, different Accept value: must MISS (not serve the html variant).
  const second = await rawRequest(dispatch, { ...base, headers: { Accept: 'application/json' } })
  t.equal(hits, 2, 'different Accept value is not served the cached html variant')
  t.equal(
    second.body,
    'accept=application/json',
    'origin response returned, not the cached variant',
  )
})

// ---------------------------------------------------------------------------
// redirect: array-form (undici native) request headers must survive a redirect
// and cross-origin authorization/cookie must still be stripped.
// ---------------------------------------------------------------------------

test('redirect: array-form headers are preserved and cross-origin auth stripped', async (t) => {
  t.plan(3)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    if (req.url === '/start') {
      // Redirect to a DIFFERENT origin (loopback IP vs localhost name) so the
      // unknown-origin auth/cookie strip applies.
      res.writeHead(301, { location: `http://localhost:${server.address().port}/final` })
      res.end()
    } else {
      res.writeHead(200)
      res.end('final')
    }
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.redirect())
  await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/start',
    method: 'GET',
    // Flat array form, mixed case, including a header that must survive and
    // cross-origin-sensitive headers that must be dropped.
    headers: ['X-Foo', 'bar', 'Authorization', 'secret', 'Cookie', 'sid=1'],
    follow: 5,
  })

  t.equal(seen.length, 2, 'redirect was followed')
  t.equal(
    seen[1]['x-foo'],
    'bar',
    'non-stripped header survives the redirect (not mangled to numeric keys)',
  )
  t.notOk('authorization' in seen[1], 'authorization stripped on cross-origin redirect')
})
