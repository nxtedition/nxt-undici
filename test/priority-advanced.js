/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

async function startServer(handler) {
  const server = createServer(handler ?? ((req, res) => res.end('ok')))
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
// priority: null bypasses the scheduler entirely
// ---------------------------------------------------------------------------

test('priority: null/undefined priority bypasses scheduler', async (t) => {
  t.plan(1)
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.priority())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    // no priority
  })
  t.equal(status, 200)
})

// ---------------------------------------------------------------------------
// priority: requests with a priority value go through the scheduler
// ---------------------------------------------------------------------------

test('priority: request with priority value is dispatched through scheduler', async (t) => {
  t.plan(1)
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.priority())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    priority: 1,
  })
  t.equal(status, 200)
})

// ---------------------------------------------------------------------------
// priority: multiple serial requests with the same origin share a scheduler
// (verified by making two requests without deadlock)
// ---------------------------------------------------------------------------

test('priority: two requests on the same origin complete in sequence', async (t) => {
  t.plan(2)
  let inFlight = 0
  let maxConcurrent = 0
  const server = await startServer((req, res) => {
    inFlight++
    maxConcurrent = Math.max(maxConcurrent, inFlight)
    setImmediate(() => {
      inFlight--
      res.end('ok')
    })
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.priority())
  await Promise.all([
    rawRequest(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
      path: '/',
      method: 'GET',
      headers: {},
      priority: 1,
    }),
    rawRequest(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
      path: '/',
      method: 'GET',
      headers: {},
      priority: 1,
    }),
  ])

  // The scheduler limits concurrency to 1, so max concurrent must be 1
  t.equal(maxConcurrent, 1, 'scheduler serialises requests (concurrency=1)')
  t.pass('both requests completed without deadlock')
})

// ---------------------------------------------------------------------------
// priority: no origin → scheduler is bypassed (no crash)
// ---------------------------------------------------------------------------

test('priority: no origin bypasses scheduler, request errors normally', async (t) => {
  t.plan(1)
  const dispatch = compose(new undici.Agent(), interceptors.priority())
  try {
    await rawRequest(dispatch, {
      // origin intentionally absent
      path: '/',
      method: 'GET',
      headers: {},
      priority: 1,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err, 'errors without crash when origin is absent')
  }
})

// ---------------------------------------------------------------------------
// priority: error in dispatch is forwarded to handler.onError
// ---------------------------------------------------------------------------

test('priority: dispatch error propagates to handler via onError', async (t) => {
  t.plan(1)
  const dispatch = compose(new undici.Agent(), interceptors.priority())
  try {
    await rawRequest(dispatch, {
      origin: 'http://127.0.0.1:1', // port 1 — nothing listening
      path: '/',
      method: 'GET',
      headers: {},
      priority: 1,
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err, 'connection error propagated to onError')
  }
})
