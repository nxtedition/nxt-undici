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

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.lookup())
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
// Callback-style lookup
// ---------------------------------------------------------------------------

test('lookup: callback-style lookup rewrites origin', async (t) => {
  t.plan(2)
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const targetOrigin = `http://127.0.0.1:${server.address().port}`

  let lookupCalled = false
  const status = await rawRequest(dispatch, {
    origin: 'http://original.example.com',
    path: '/',
    method: 'GET',
    headers: {},
    lookup: (origin, opts, callback) => {
      lookupCalled = true
      // Redirect all requests to our test server
      callback(null, targetOrigin)
    },
  })

  t.ok(lookupCalled, 'lookup was called')
  t.equal(status, 200)
})

// ---------------------------------------------------------------------------
// Promise/thenable-style lookup
// ---------------------------------------------------------------------------

test('lookup: thenable lookup rewrites origin', async (t) => {
  t.plan(2)
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const targetOrigin = `http://127.0.0.1:${server.address().port}`

  let lookupCalled = false
  const status = await rawRequest(dispatch, {
    origin: 'http://original.example.com',
    path: '/',
    method: 'GET',
    headers: {},
    lookup: (origin, opts, callback) => {
      lookupCalled = true
      // Return a thenable instead of using callback
      return Promise.resolve(targetOrigin)
    },
  })

  t.ok(lookupCalled, 'lookup was called')
  t.equal(status, 200)
})

// ---------------------------------------------------------------------------
// Lookup error propagates correctly
// ---------------------------------------------------------------------------

test('lookup: callback error propagates as request error', async (t) => {
  t.plan(1)
  const dispatch = makeDispatch()

  try {
    await rawRequest(dispatch, {
      origin: 'http://original.example.com',
      path: '/',
      method: 'GET',
      headers: {},
      lookup: (origin, opts, callback) => {
        callback(new Error('lookup failed'))
      },
    })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.message, 'lookup failed')
  }
})

// ---------------------------------------------------------------------------
// Thenable rejection propagates correctly
// ---------------------------------------------------------------------------

test('lookup: thenable rejection propagates as request error', async (t) => {
  t.plan(1)
  const dispatch = makeDispatch()

  try {
    await rawRequest(dispatch, {
      origin: 'http://original.example.com',
      path: '/',
      method: 'GET',
      headers: {},
      lookup: () => Promise.reject(new Error('thenable rejected')),
    })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.message, 'thenable rejected')
  }
})

// ---------------------------------------------------------------------------
// No lookup → passthrough
// ---------------------------------------------------------------------------

test('lookup: no lookup option passes through unchanged', async (t) => {
  t.plan(1)
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    lookup: null,
  })
  t.equal(status, 200)
})
