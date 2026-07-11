/* eslint-disable */
// Regression tests for core lifecycle / contract bugs from the second in-depth
// review: cache double-terminal-callback, request-body-factory premature close,
// priority scheduler keying + sync-throw, request() sync-throw cleanup,
// request-id falsy ids, query path guard, lookup double-onError, and the
// index.js global-header / nxt-priority normalization.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { request, compose, interceptors } from '../lib/index.js'
import { request as rawRequestFn } from '../lib/request.js'
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

const tick = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// cache: a cache-hit handler whose onComplete throws must NOT then receive
// onError (terminal callbacks are mutually exclusive).
// ---------------------------------------------------------------------------

test('cache: onComplete throwing on a cache hit does not trigger onError', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'cache-control': 's-maxage=60' })
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = compose(new undici.Agent(), interceptors.cache())
  const opts = {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    cache: { store },
  }

  await rawRequest(dispatch, opts) // populate

  let onErrorCalled = false
  let threw = false
  try {
    dispatch(opts, {
      onConnect() {},
      onHeaders() {},
      onData() {},
      onComplete() {
        throw new Error('boom from onComplete')
      },
      onError() {
        onErrorCalled = true
      },
    })
  } catch {
    threw = true
  }
  await tick()
  t.ok(threw, 'the onComplete error propagates out of dispatch')
  t.notOk(onErrorCalled, 'onError is not called after onComplete')
})

// ---------------------------------------------------------------------------
// request-body-factory: an inner body that errors mid-stream rejects the
// request; one destroyed without 'end'/'error' (premature close) also fails
// the request rather than hanging forever.
// ---------------------------------------------------------------------------

test('request-body-factory: inner body error rejects the request', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    req.resume()
    req.on('end', () => res.end('ok'))
  })
  t.teardown(server.close.bind(server))

  await t.rejects(
    request(`http://127.0.0.1:${server.address().port}`, {
      method: 'POST',
      body: () => {
        const r = new Readable({ read() {} })
        r.push('partial')
        setImmediate(() => r.emit('error', new Error('inner boom')))
        return r
      },
    }),
    /inner boom/,
    'inner-body error surfaces as a request error',
  )
})

test('request-body-factory: inner body premature close fails the request (no hang)', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    req.resume()
    req.on('end', () => res.end('ok'))
  })
  t.teardown(server.close.bind(server))

  await t.rejects(
    request(`http://127.0.0.1:${server.address().port}`, {
      method: 'POST',
      body: () => {
        const r = new Readable({ read() {} })
        r.push('partial')
        setImmediate(() => r.destroy()) // no 'end', no 'error' — only 'close'
        return r
      },
    }),
    /premature close|ERR_STREAM_PREMATURE_CLOSE/i,
    'premature close fails the request instead of hanging',
  )
})

// ---------------------------------------------------------------------------
// priority: a logical host shared across rotating origins (as the DNS
// interceptor produces) must serialize through ONE scheduler.
// ---------------------------------------------------------------------------

test('priority: requests sharing a host serialize even when origin differs', (t) => {
  t.plan(4)
  const calls = []
  let connect1
  const base = (opts, h) => {
    calls.push(opts.origin)
    const drive = () => {
      h.onConnect(() => {})
      h.onHeaders(200, {}, () => {})
      h.onComplete(null)
    }
    if (calls.length === 1) {
      connect1 = drive // hold the slot until released
    } else {
      drive()
    }
  }
  const dispatch = compose(base, interceptors.priority())
  const mk = (origin) => ({
    origin,
    path: '/',
    method: 'GET',
    headers: { host: 'shared.example' },
    priority: 1,
  })
  const noop = () => ({
    onConnect() {},
    onHeaders() {
      return true
    },
    onData() {},
    onComplete() {},
    onError() {},
  })

  dispatch(mk('http://10.0.0.1'), noop())
  dispatch(mk('http://10.0.0.2'), noop())

  t.equal(calls.length, 1, 'second request queued behind the first (same host key)')
  t.equal(calls[0], 'http://10.0.0.1')
  connect1() // first connects -> releases slot -> second dispatches
  t.equal(calls.length, 2, 'second request dispatched after the first releases its slot')
  t.equal(calls[1], 'http://10.0.0.2')
})

// ---------------------------------------------------------------------------
// priority: a synchronous throw from dispatch is forwarded to onError and the
// slot is released so a subsequent request still runs.
// ---------------------------------------------------------------------------

test('priority: synchronous dispatch throw is forwarded to onError and slot released', async (t) => {
  t.plan(2)
  let calls = 0
  const base = (opts, handler) => {
    calls++
    if (calls === 1) {
      throw new Error('sync boom')
    }
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete(null)
  }
  const dispatch = compose(base, interceptors.priority())
  const origin = 'http://127.0.0.1:9'
  await t.rejects(
    rawRequest(dispatch, { origin, path: '/', method: 'GET', headers: {}, priority: 1 }),
    /sync boom/,
    'sync throw forwarded via onError',
  )
  await t.resolves(
    rawRequest(dispatch, { origin, path: '/', method: 'GET', headers: {}, priority: 1 }),
    'a subsequent request still runs after the slot is released',
  )
})

// ---------------------------------------------------------------------------
// request(): a synchronous throw from dispatch destroys the body stream and
// removes the abort-signal listener instead of leaking them.
// ---------------------------------------------------------------------------

test('request(): synchronous dispatch throw cleans up body and signal listener', async (t) => {
  t.plan(3)
  const signal = new EventEmitter()
  const body = new Readable({ read() {} })
  const throwingDispatch = () => {
    throw new Error('sync dispatch boom')
  }
  await t.rejects(
    rawRequestFn(throwingDispatch, 'http://x.invalid', { body, signal }),
    /sync dispatch boom/,
    'synchronous throw rejects the request',
  )
  t.equal(body.destroyed, true, 'request body stream was destroyed')
  t.equal(signal.listenerCount('abort'), 0, 'abort listener was removed')
})

// ---------------------------------------------------------------------------
// request-id: an empty opts.id must fall back to the request-id header so the
// real parent id is preserved in the chain.
// ---------------------------------------------------------------------------

test('request-id: empty opts.id falls back to the request-id header', (t) => {
  t.plan(1)
  let outgoing
  const base = (opts, handler) => {
    outgoing = opts.headers['request-id']
    handler.onConnect(() => {})
    handler.onComplete(null)
  }
  const dispatch = compose(base, interceptors.requestId())
  dispatch(
    {
      origin: 'http://x',
      path: '/',
      method: 'GET',
      id: '',
      headers: { 'request-id': 'real-parent' },
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
  t.match(outgoing, /^real-parent,req-/, 'real parent id chained instead of dropped')
})

// ---------------------------------------------------------------------------
// query: request() now defaults a path-less object URL to '/', so a query on
// a path-less request works. The interceptor's clear non-string-path message
// (instead of a cryptic "Cannot read properties of undefined") still guards
// raw dispatch, which performs no such defaulting.
// ---------------------------------------------------------------------------

test('query: path-less request with query resolves against /', async (t) => {
  t.plan(2)
  const server = createServer((req, res) => {
    t.equal(req.url, '/?a=1', 'query appended to the defaulted /')
    res.end('ok')
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(() => server.close())

  const { statusCode, body } = await request({
    origin: `http://127.0.0.1:${server.address().port}`,
    query: { a: 1 },
    retry: false,
  })
  await body.dump()
  t.equal(statusCode, 200)
})

test('query: raw dispatch without a path rejects with a clear message', async (t) => {
  t.plan(1)
  const dispatch = compose((opts, handler) => handler.onComplete(), interceptors.query())
  t.throws(
    () => dispatch({ origin: 'http://0.0.0.0:1', query: { a: 1 } }, {}),
    /string path/,
    'clear error instead of a cryptic TypeError',
  )
})

// ---------------------------------------------------------------------------
// lookup: a downstream that reports onError and then throws synchronously must
// not produce a second onError.
// ---------------------------------------------------------------------------

test('lookup: downstream report-then-throw yields a single onError', async (t) => {
  t.plan(1)
  let onErrorCount = 0
  const base = (opts, handler) => {
    handler.onConnect(() => {})
    handler.onError(new Error('downstream error'))
    throw new Error('and then throw')
  }
  const dispatch = compose(base, interceptors.lookup())
  await new Promise((resolve) => {
    dispatch(
      {
        origin: 'http://x',
        path: '/',
        method: 'GET',
        headers: {},
        lookup: (origin, _opts, cb) => cb(null, origin),
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
        onError() {
          onErrorCount++
          setImmediate(resolve)
        },
      },
    )
  })
  t.equal(onErrorCount, 1, 'onError delivered exactly once')
})

// ---------------------------------------------------------------------------
// index.js: globalThis.__nxt_undici_global_headers are normalized (lowercased)
// like every other header source.
// ---------------------------------------------------------------------------

test('index: global headers are normalized to lowercase', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(req.headers['x-global'] ?? 'absent')
  })
  t.teardown(server.close.bind(server))
  globalThis.__nxt_undici_global_headers = { 'X-Global': 'gval' }
  t.teardown(() => {
    delete globalThis.__nxt_undici_global_headers
  })

  const { body } = await request(`http://127.0.0.1:${server.address().port}`, {})
  let str = ''
  for await (const chunk of body) str += chunk
  t.equal(str, 'gval', 'mixed-case global header reached the origin as a lowercase key')
})

// ---------------------------------------------------------------------------
// index.js: a duplicated nxt-priority request header (array) is coerced to a
// scalar before reaching the scheduler instead of feeding it an array.
// ---------------------------------------------------------------------------

test('index: duplicated nxt-priority header does not break the request', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const { statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    headers: { 'nxt-priority': ['high', 'low'] },
  })
  t.equal(statusCode, 200, 'array-valued nxt-priority is coerced to a scalar, request completes')
})
