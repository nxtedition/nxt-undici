/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

// ---------------------------------------------------------------------------
// Helper: build a dispatcher that uses only the dns interceptor
// ---------------------------------------------------------------------------
function makeDispatch() {
  return compose(new undici.Agent(), interceptors.dns())
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
