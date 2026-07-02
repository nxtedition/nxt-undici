// Regression tests for duplicated (array-valued) Cache-Control field lines.
// Cache-Control is a list-typed field, so duplicated field lines are RFC-legal
// and common (e.g. CDN + origin each adding one). The undici header parser
// collects repeated field lines into an array, which parseCacheControl used to
// pass straight into cache-control-parser's parse() — whose first operation is
// str.toLowerCase() — turning every such response/request into a TypeError.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import { parseCacheControl } from '../lib/utils.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.cache())
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

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

// ---------------------------------------------------------------------------
// parseCacheControl unit tests
// ---------------------------------------------------------------------------

test('parseCacheControl - array value is combined and parsed', (t) => {
  t.strictSame(parseCacheControl(['max-age=600', 'public']), { 'max-age': 600, public: true })
  t.end()
})

test('parseCacheControl - single-element array', (t) => {
  t.strictSame(parseCacheControl(['no-store']), { 'no-store': true })
  t.end()
})

test('parseCacheControl - non-string values return null', (t) => {
  t.equal(parseCacheControl([]), null)
  t.equal(parseCacheControl(123), null)
  t.equal(parseCacheControl(null), null)
  t.equal(parseCacheControl(undefined), null)
  t.equal(parseCacheControl(''), null)
  t.end()
})

// ---------------------------------------------------------------------------
// Response side: duplicated Cache-Control field lines must not abort the
// request. Previously the TypeError escaped CacheHandler.onHeaders and
// undici converted it into abort(err) — every otherwise-good cacheable 200
// from such an origin failed.
// ---------------------------------------------------------------------------

test('cache: response with duplicated Cache-Control field lines succeeds and is cached', async (t) => {
  t.plan(4)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // Sends TWO Cache-Control field lines.
    res.setHeader('cache-control', ['max-age=600', 'public'])
    res.setHeader('content-type', 'text/plain')
    res.end('dual cache-control body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()
  const opts = {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  const first = await rawRequest(dispatch, opts)
  t.equal(first.statusCode, 200, 'first request succeeds despite duplicated Cache-Control')
  t.equal(first.body, 'dual cache-control body', 'first response body intact')

  const second = await rawRequest(dispatch, opts)
  t.equal(second.statusCode, 200, 'second request succeeds')
  t.equal(hits, 1, 'combined directives honored — second request served from cache')
})

// ---------------------------------------------------------------------------
// Request side: array-form request cache-control must not throw synchronously
// out of dispatch().
// ---------------------------------------------------------------------------

test('cache: array-form request cache-control does not throw', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()

  const result = await rawRequest(dispatch, {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { 'cache-control': ['no-transform', 'no-store'] },
    cache: { store },
  })

  t.equal(result.statusCode, 200, 'request with array cache-control succeeds')
  t.equal(hits, 1, 'request reached the server')
})

test('cache: only-if-cached honored when supplied in an array element', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = makeDispatch()

  const { statusCode } = await rawRequest(dispatch, {
    origin: `http://0.0.0.0:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { 'cache-control': ['no-transform', 'only-if-cached'] },
    cache: { store },
  })

  t.equal(statusCode, 504, 'only-if-cached in array returns 504 on cache miss')
  t.equal(hits, 0, 'server must not be contacted for only-if-cached miss')
})
