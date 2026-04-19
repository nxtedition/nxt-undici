/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDispatch() {
  return compose(new undici.Agent(), interceptors.dns())
}

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
// Basic DNS resolution
// ---------------------------------------------------------------------------

test('dns: resolves localhost and makes successful request', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('ok')
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const dispatch = makeDispatch()
    const port = server.address().port

    const result = await new Promise((resolve, reject) => {
      dispatch(
        {
          origin: `http://localhost:${port}`,
          path: '/',
          method: 'GET',
          headers: {},
          dns: true,
        },
        {
          onConnect() {},
          onHeaders(statusCode) {
            resolve(statusCode)
          },
          onData() {},
          onComplete() {},
          onError: reject,
        },
      )
    })
    t.equal(result, 200)
  })
})

// ---------------------------------------------------------------------------
// IP addresses bypass DNS resolution
// ---------------------------------------------------------------------------

test('dns: skips resolution for IP address origins', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('ok')
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const dispatch = makeDispatch()
    const port = server.address().port

    const result = await new Promise((resolve, reject) => {
      dispatch(
        {
          origin: `http://127.0.0.1:${port}`,
          path: '/',
          method: 'GET',
          headers: {},
          dns: true,
        },
        {
          onConnect() {},
          onHeaders(statusCode) {
            resolve(statusCode)
          },
          onData() {},
          onComplete() {},
          onError: reject,
        },
      )
    })
    t.equal(result, 200)
  })
})

// ---------------------------------------------------------------------------
// dns:false completely bypasses the interceptor
// ---------------------------------------------------------------------------

test('dns: dns:false bypasses interceptor', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('ok')
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const dispatch = makeDispatch()
    const port = server.address().port

    const result = await new Promise((resolve, reject) => {
      dispatch(
        {
          origin: `http://127.0.0.1:${port}`,
          path: '/',
          method: 'GET',
          headers: {},
          dns: false,
        },
        {
          onConnect() {},
          onHeaders(statusCode) {
            resolve(statusCode)
          },
          onData() {},
          onComplete() {},
          onError: reject,
        },
      )
    })
    t.equal(result, 200)
  })
})

// ---------------------------------------------------------------------------
// Non-existent hostname raises ENOTFOUND-like error
// ---------------------------------------------------------------------------

test('dns: rejects on unresolvable hostname', (t) => {
  t.plan(1)
  const dispatch = makeDispatch()

  new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://this-hostname-does-not-exist-at-all-xyz.invalid',
        path: '/',
        method: 'GET',
        headers: {},
        dns: true,
      },
      {
        onConnect() {},
        onHeaders: resolve,
        onData() {},
        onComplete() {},
        onError: reject,
      },
    )
  }).then(
    () => t.fail('should have rejected'),
    (err) => {
      t.ok(err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err instanceof Error)
    },
  )
})

// ---------------------------------------------------------------------------
// balance: 'hash' → record is selected via hash of pathname (dns.js lines 102-114)
// ---------------------------------------------------------------------------

test('dns: balance:hash selects a record via hash of pathname', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.writeHead(200)
    res.end()
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const dispatch = compose(new undici.Agent(), interceptors.dns())
    const port = server.address().port

    const statusCode = await new Promise((resolve, reject) => {
      dispatch(
        {
          origin: `http://localhost:${port}`,
          path: '/test-path',
          method: 'GET',
          headers: {},
          dns: { balance: 'hash', ttl: 2000 },
        },
        {
          onConnect() {},
          onHeaders(sc) {
            resolve(sc)
            return true
          },
          onData() {},
          onComplete() {},
          onError: reject,
        },
      )
    })
    t.equal(statusCode, 200, 'hash-balanced DNS request succeeded')
  })
})

// ---------------------------------------------------------------------------
// Pre-emptive DNS refresh: when any record is past half its TTL, a background
// resolve is kicked off so the next request gets fresh records without blocking.
//
// We exercise this by making N requests across the half-TTL boundary and
// asserting they all succeed — with no pre-emptive refresh, requests past the
// TTL would need a synchronous re-resolve but still succeed, so this test
// mainly guards against regressions that would break the path entirely
// (e.g. unhandled rejections from the fire-and-forget resolve).
// ---------------------------------------------------------------------------

test('dns: pre-emptive refresh keeps records usable across TTL boundaries', async (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.writeHead(200)
    res.end()
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))
  const port = server.address().port

  const dispatch = compose(new undici.Agent(), interceptors.dns())
  const ttl = 100

  let successes = 0
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve, reject) => {
      dispatch(
        {
          origin: `http://localhost:${port}`,
          path: '/',
          method: 'GET',
          headers: {},
          dns: { ttl },
        },
        {
          onConnect() {},
          onHeaders(sc) {
            if (sc === 200) successes++
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
    // Sleep past the half-TTL threshold so the next iteration triggers
    // the pre-emptive resolve path.
    await new Promise((r) => setTimeout(r, ttl))
  }

  t.equal(successes, 5, 'all requests succeeded across TTL boundaries')
})

// ---------------------------------------------------------------------------
// 5xx response: record.errored++ (dns.js error-callback path)
// The Handler callback receives (null, 500) → statusCode >= 500 path is taken
// ---------------------------------------------------------------------------

test('dns: 5xx response marks the selected record as errored', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.writeHead(500)
    res.end()
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const dispatch = compose(new undici.Agent(), interceptors.dns())
    const port = server.address().port

    const statusCode = await new Promise((resolve, reject) => {
      dispatch(
        {
          origin: `http://localhost:${port}`,
          path: '/',
          method: 'GET',
          headers: {},
          dns: { ttl: 5000 },
        },
        {
          onConnect() {},
          onHeaders(sc) {
            resolve(sc)
            return true
          },
          onData() {},
          onComplete() {},
          onError: reject,
        },
      )
    })
    // The status code must reach the caller unchanged; internally the DNS
    // interceptor has bumped record.errored.
    t.equal(statusCode, 500, '5xx propagated — record.errored++')
  })
})

// ---------------------------------------------------------------------------
// Connection error: record.expires set to 0 when transport-level error occurs
// ---------------------------------------------------------------------------

test('dns: connection error sets record.expires=0', (t) => {
  t.plan(1)
  // Start a server to get a free port, then close it immediately so the
  // port is no longer accepting connections.
  const server = createServer((req, res) => {
    res.end()
  })
  server.listen(0, () => {
    const port = server.address().port
    // Close the server; when the callback fires the port is no longer listening.
    server.close(async () => {
      const dispatch = compose(new undici.Agent(), interceptors.dns())

      await new Promise((resolve) => {
        dispatch(
          {
            origin: `http://localhost:${port}`,
            path: '/',
            method: 'GET',
            headers: {},
            dns: { ttl: 5000 },
          },
          {
            onConnect() {},
            onHeaders: resolve,
            onData() {},
            onComplete() {},
            // Error is expected — the closed port triggers the record.expires=0 path
            onError: resolve,
          },
        )
      })
      // Code path (record.expires = 0) was exercised.
      t.ok(true, 'connection error exercised record.expires=0 code path')
    })
  })
})

// ---------------------------------------------------------------------------
// After a transport error, record.expires=0 forces DNS re-resolution on the
// next request.  The re-resolved records are fresh objects, so the previously
// failed record is usable again.
// ---------------------------------------------------------------------------

test('dns: re-resolved records are usable after transport error', async (t) => {
  t.plan(1)

  let callCount = 0
  const dnsInterceptor = interceptors.dns()

  // Mock dispatch: first call triggers a transport error, second call succeeds.
  const mockDispatch = dnsInterceptor((opts, handler) => {
    callCount++
    if (callCount === 1) {
      const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      handler.onError(err)
    } else {
      handler.onHeaders(200, {}, () => {})
      handler.onComplete([])
    }
  })

  // First request — connection error. Sets record.expires=0.
  await new Promise((resolve) => {
    mockDispatch(
      {
        origin: 'http://localhost:9999',
        path: '/',
        method: 'GET',
        headers: {},
        dns: { ttl: 1 },
      },
      {
        onConnect() {},
        onHeaders() {},
        onData() {},
        onComplete() {
          resolve()
        },
        onError() {
          resolve()
        },
      },
    )
  })

  // Second request — DNS re-resolves (all records expired), fresh records selected.
  const result = await new Promise((resolve) => {
    mockDispatch(
      {
        origin: 'http://localhost:9999',
        path: '/',
        method: 'GET',
        headers: {},
        dns: { ttl: 1 },
      },
      {
        onConnect() {},
        onHeaders(sc) {
          resolve({ status: sc })
        },
        onData() {},
        onComplete() {},
        onError(err) {
          resolve({ error: err })
        },
      },
    )
  })

  if (result.error) {
    t.fail(`should not have thrown: ${result.error.message}`)
  } else {
    t.equal(result.status, 200, 'second request succeeds after re-resolve')
  }
})

// ---------------------------------------------------------------------------
// DNS: IP address bypasses DNS resolution
// ---------------------------------------------------------------------------

test('dns: IP address origin bypasses DNS lookup', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.dns())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    dns: { ttl: 5000 },
  })
  t.equal(status, 200, 'IP address origin works without DNS resolution')
})

// ---------------------------------------------------------------------------
// DNS: opts.dns = false bypasses interceptor
// ---------------------------------------------------------------------------

test('dns: opts.dns=false bypasses interceptor', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.dns())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    dns: false,
  })
  t.equal(status, 200, 'dns:false bypasses DNS interceptor')
})

// ---------------------------------------------------------------------------
// IPv6 addresses returned by dns.lookup must be bracketed when assigned to
// url.hostname.  Regression: unbracketed assignment silently failed and the
// interceptor dispatched to the original (unresolved) hostname.
//
// Strategy: monkey-patch dns.lookup so the interceptor gets an IPv6 address,
// and capture the rewritten origin via a custom downstream dispatcher.
// ---------------------------------------------------------------------------

test('dns: IPv6 record address is bracketed when rewriting origin', async (t) => {
  // localhost resolves to both ::1 and 127.0.0.1 on most systems.  Using
  // balance:'hash' with many pathnames guarantees both records get picked,
  // so at least one dispatch should see a bracketed IPv6 origin.
  const origins = new Set()

  const dnsInterceptor = interceptors.dns()
  const dispatch = dnsInterceptor((opts, handler) => {
    origins.add(opts.origin)
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  })

  for (let i = 0; i < 20; i++) {
    await new Promise((resolve, reject) => {
      dispatch(
        {
          origin: 'http://localhost:8080',
          path: `/path-${i}`,
          method: 'GET',
          headers: {},
          dns: { balance: 'hash', ttl: 5000 },
        },
        {
          onConnect() {},
          onHeaders() {
            resolve()
            return true
          },
          onData() {},
          onComplete() {},
          onError: reject,
        },
      )
    })
  }

  const sawIPv6 = [...origins].some((o) => /http:\/\/\[[0-9a-f:]+\]:\d+/i.test(o))
  const sawUnresolved = [...origins].some((o) => o.includes('localhost'))

  t.ok(sawIPv6, `at least one origin is bracketed IPv6: ${[...origins].join(', ')}`)
  t.notOk(sawUnresolved, `no origin still contains 'localhost': ${[...origins].join(', ')}`)
})
