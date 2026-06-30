// Regression tests for the third in-depth review pass:
//  - dns: successful upgrade settles the pending gauge (was leaked forever)
//  - dns: a non-connection error no longer hard-invalidates a reachable IP
//  - redirect: 1xx informational responses pass through (no AssertionError)
//  - response-verify: bodyless 304/204 carrying Content-Length is not a mismatch
//  - index: partial object-form opts.timeout no longer leaks into the other field
//  - cache: a cache hit served to a request with a non-stream body does not crash
//  - proxy: the hop-by-hop `Trailer` header is stripped, not relayed
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { compose, interceptors, request } from '../lib/index.js'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'

// ---------------------------------------------------------------------------
// dns: a successful upgrade (HTTP 101) is a terminal branch with no
// onComplete/onError. The dns Handler must settle record.pending there too,
// otherwise the upgraded record keeps a phantom pending count and the
// load-balancer's (errored, pending, counter) sort permanently deprioritizes
// it — it is never selected again. We observe that skew: drive an upgrade on
// the first-selected record, then several ordinary requests, and assert the
// upgraded record is selected again. (localhost resolves to ::1 + 127.0.0.1 on
// most systems; the test self-skips if only one address is available.)
// ---------------------------------------------------------------------------

test('dns: a successful upgrade settles the gauge so the record stays selectable', async (t) => {
  const seen = []
  const dispatch = interceptors.dns()((opts, handler) => {
    seen.push(opts.origin)
    handler.onConnect(() => {})
    if (seen.length === 1) {
      // First request: simulate a successful protocol upgrade.
      handler.onUpgrade(101, {}, { on() {}, end() {}, destroy() {} })
    } else {
      handler.onHeaders(200, {}, () => {})
      handler.onComplete([])
    }
  })

  const run = (i) =>
    new Promise((resolve, reject) => {
      dispatch(
        {
          origin: 'http://localhost:8080',
          path: `/p-${i}`,
          method: 'GET',
          headers: {},
          dns: { ttl: 30000 },
        },
        {
          onConnect() {},
          onUpgrade() {
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

  for (let i = 0; i < 8; i++) {
    await run(i)
  }

  const distinct = new Set(seen)
  if (distinct.size < 2) {
    t.pass(`localhost resolved to a single address (${[...distinct]}); skew test not applicable`)
    return
  }

  const upgraded = seen[0]
  t.ok(
    seen.slice(1).includes(upgraded),
    `the upgraded record (${upgraded}) is still selected after the upgrade settles — pending not leaked`,
  )
})

// ---------------------------------------------------------------------------
// dns: only genuine connection-level errors hard-invalidate (expires=0) the
// selected record. A body/headers timeout means the IP was reachable, so it
// must NOT thrash DNS. We can't observe the internal gauge, so this asserts the
// two branches both run without crashing and propagate the error to the caller.
// ---------------------------------------------------------------------------

test('dns: both connection and non-connection errors propagate without crashing', async (t) => {
  t.plan(3)
  let call = 0
  const dispatch = interceptors.dns()((opts, handler) => {
    call++
    handler.onConnect(() => {})
    if (call === 1) {
      handler.onError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    } else if (call === 2) {
      handler.onError(Object.assign(new Error('body timeout'), { code: 'UND_ERR_BODY_TIMEOUT' }))
    } else {
      handler.onHeaders(200, {}, () => {})
      handler.onComplete([])
    }
  })

  const run = () =>
    new Promise((resolve) => {
      dispatch(
        {
          origin: 'http://localhost:8080',
          path: '/',
          method: 'GET',
          headers: {},
          dns: { ttl: 30000 },
        },
        {
          onConnect() {},
          onHeaders(sc) {
            resolve({ sc })
            return true
          },
          onData() {},
          onComplete() {},
          onError: (err) => resolve({ err }),
        },
      )
    })

  const r1 = await run()
  t.equal(r1.err?.code, 'ECONNREFUSED', 'connection error reaches the caller (invalidates the IP)')
  const r2 = await run()
  t.equal(
    r2.err?.code,
    'UND_ERR_BODY_TIMEOUT',
    'body timeout reaches the caller (soft-penalized, IP kept)',
  )
  const r3 = await run()
  t.equal(r3.sc, 200, 'a subsequent request still succeeds')
})

// ---------------------------------------------------------------------------
// redirect: a 1xx informational response (e.g. 103 Early Hints) delivered
// before the final response must pass through. Pre-fix the second onHeaders
// tripped `assert(!this.#headersSent)`, turning a good 200 into an error.
// (raw undici strips 1xx, so — like the equivalent response-retry test — we
// drive it through a mock dispatch.)
// ---------------------------------------------------------------------------

test('redirect: a 1xx informational response passes through to the final 200', async (t) => {
  t.plan(2)
  const mockDispatch = (opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(103, { link: '</style.css>; rel=preload' }, () => {})
    handler.onHeaders(200, { 'content-length': '5' }, () => {})
    handler.onData(Buffer.from('hello'))
    handler.onComplete({})
    return true
  }
  const dispatch = compose(mockDispatch, interceptors.redirect())

  const result = await new Promise((resolve, reject) => {
    let statusCode
    const chunks = []
    dispatch(
      { method: 'GET', path: '/', origin: 'http://x', follow: 8 },
      {
        onConnect() {},
        onHeaders(sc) {
          statusCode = sc
          return true
        },
        onData(chunk) {
          chunks.push(chunk)
        },
        onComplete() {
          resolve({ statusCode, body: Buffer.concat(chunks).toString() })
        },
        onError: reject,
      },
    )
  })

  t.equal(result.statusCode, 200, '200 delivered after the 1xx')
  t.equal(result.body, 'hello', 'body delivered correctly')
})

// ---------------------------------------------------------------------------
// response-verify: bodyless responses (304 Not Modified, 204 No Content, 205
// Reset Content) may carry a Content-Length describing the full representation.
// Verifying the (absent) body against it pre-fix produced a false "body size
// mismatch" error, breaking conditional-request revalidation.
// ---------------------------------------------------------------------------

test('verify: bodyless statuses carrying Content-Length are not flagged as a size mismatch', async (t) => {
  t.plan(3)
  // await the import so a rejection is attributed to this test rather than
  // surfacing as a planned-assertion shortfall / timeout.
  const { default: responseVerify } = await import('../lib/interceptor/response-verify.js')
  for (const status of [304, 204, 205]) {
    let errored = false
    let completed = false
    const handler = {
      onConnect() {},
      onHeaders() {
        return true
      },
      onData() {},
      onComplete() {
        completed = true
      },
      onError() {
        errored = true
      },
    }
    const fakeDispatch = (opts, h) => {
      h.onConnect(() => {})
      h.onHeaders(status, { 'content-length': '100' }, () => {})
      h.onComplete({})
    }
    responseVerify()(fakeDispatch)({ verify: { size: true }, method: 'GET' }, handler)
    t.ok(
      completed && !errored,
      `${status} with content-length completes without a size-mismatch error`,
    )
  }
})

// ---------------------------------------------------------------------------
// index: opts.timeout may be a number or an object { headers, body }. An object
// form that sets only one field pre-fix leaked the whole object into the other
// timeout, which undici rejects with InvalidArgumentError.
// ---------------------------------------------------------------------------

test('index: partial object-form opts.timeout does not leak into the other timeout', async (t) => {
  t.plan(2)
  const server = createServer((req, res) => res.end('ok'))
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`

  const a = await request(url, { timeout: { headers: 500 } })
  a.body.on('error', () => {}).resume()
  t.equal(a.statusCode, 200, 'timeout:{headers} works (bodyTimeout not poisoned)')

  const b = await request(url, { timeout: { body: 500 } })
  b.body.on('error', () => {}).resume()
  t.equal(b.statusCode, 200, 'timeout:{body} works (headersTimeout not poisoned)')
})

// ---------------------------------------------------------------------------
// cache: serveFromCache drains the request body to release it, but pre-fix it
// called opts.body.on(...).resume() unconditionally — a TypeError for a
// Buffer/string body, which aborted an otherwise-valid cache hit.
// ---------------------------------------------------------------------------

test('cache: a cache hit served to a request with a non-stream body does not crash', async (t) => {
  t.plan(2)
  const store = new SqliteCacheStore({ location: ':memory:' })
  t.teardown(() => store.close())

  const server = createServer((req, res) => {
    res.writeHead(200, {
      'cache-control': 'public, max-age=60',
      'content-length': '5',
      'content-type': 'text/plain',
    })
    res.end('hello')
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`

  // 1) populate the cache
  const r1 = await request(url, { cache: { store } })
  t.equal(await r1.body.text(), 'hello', 'origin response cached')

  // 2) cache hit, this time with a Buffer request body
  const r2 = await request(url, { method: 'GET', body: Buffer.from('x'), cache: { store } })
  t.equal(await r2.body.text(), 'hello', 'served from cache without crashing on the buffer body')
})

// ---------------------------------------------------------------------------
// proxy: `Trailer` (RFC 7230 §4.4) is a hop-by-hop header and must not be
// relayed. Pre-fix the length-dispatch table only matched `upgrade` at length
// 7, so the real `Trailer` (also length 7) leaked to the next hop.
// ---------------------------------------------------------------------------

test('proxy: the hop-by-hop Trailer header is stripped, not relayed', async (t) => {
  t.plan(2)
  let captured
  const dispatch = interceptors.proxy()((opts, handler) => {
    captured = opts.headers
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete({})
  })

  await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://up.example',
        path: '/',
        method: 'GET',
        proxy: {},
        headers: { trailer: 'X-Checksum', 'x-keep': 'yes' },
      },
      {
        onConnect() {},
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

  t.notOk('trailer' in captured, 'Trailer stripped as hop-by-hop')
  t.equal(captured['x-keep'], 'yes', 'ordinary headers are still relayed')
})
