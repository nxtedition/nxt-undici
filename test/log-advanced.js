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

function makeMockLogger() {
  const calls = { debug: [], warn: [], error: [] }
  const logger = {
    calls,
    debug(...args) {
      calls.debug.push(args)
    },
    warn(...args) {
      calls.warn.push(args)
    },
    error(...args) {
      calls.error.push(args)
    },
    child(bindings) {
      // Return a new mock that inherits the same calls array so we can inspect
      return makeMockLoggerChild(calls)
    },
  }
  return logger
}

function makeMockLoggerChild(calls) {
  return {
    calls,
    debug(...args) {
      calls.debug.push(args)
    },
    warn(...args) {
      calls.warn.push(args)
    },
    error(...args) {
      calls.error.push(args)
    },
    child(bindings) {
      return makeMockLoggerChild(calls)
    },
  }
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
// log interceptor is bypassed when opts.logger is absent
// ---------------------------------------------------------------------------

test('log: interceptor bypassed when no logger', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.log())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    // no logger
  })
  t.equal(status, 200)
})

// ---------------------------------------------------------------------------
// 2xx response → logger.debug called with "upstream request completed"
// ---------------------------------------------------------------------------

test('log: 2xx response calls logger.debug', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    res.writeHead(200)
    res.end('body')
  })
  t.teardown(server.close.bind(server))

  const logger = makeMockLogger()
  const dispatch = compose(new undici.Agent(), interceptors.log())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    logger,
  })
  t.equal(status, 200)
  t.ok(
    logger.calls.debug.some((args) => String(args[args.length - 1]).includes('upstream request')),
    'debug was called for 2xx response',
  )
})

// ---------------------------------------------------------------------------
// 4xx response → logger.warn called
// ---------------------------------------------------------------------------

test('log: 4xx response calls logger.warn', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const logger = makeMockLogger()
  const dispatch = compose(new undici.Agent(), interceptors.log())
  await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    logger,
  })
  t.ok(
    logger.calls.warn.some((args) => String(args[args.length - 1]).includes('upstream request')),
    'warn was called for 4xx response',
  )
})

// ---------------------------------------------------------------------------
// 5xx response → logger.error called
// ---------------------------------------------------------------------------

test('log: 5xx response calls logger.error', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(500)
    res.end()
  })
  t.teardown(server.close.bind(server))

  const logger = makeMockLogger()
  const dispatch = compose(new undici.Agent(), interceptors.log())
  await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    logger,
  })
  t.ok(
    logger.calls.error.some((args) => String(args[args.length - 1]).includes('upstream request')),
    'error was called for 5xx response',
  )
})

// ---------------------------------------------------------------------------
// Connection error → logger.error called with "upstream request failed"
// ---------------------------------------------------------------------------

test('log: connection error calls logger.error with "upstream request failed"', async (t) => {
  t.plan(1)
  const logger = makeMockLogger()
  const dispatch = compose(new undici.Agent(), interceptors.log())

  try {
    await rawRequest(dispatch, {
      origin: 'http://127.0.0.1:1', // nothing listening on port 1
      path: '/',
      method: 'GET',
      headers: {},
      logger,
    })
  } catch {
    // expected
  }

  t.ok(
    logger.calls.error.some((args) => String(args[args.length - 1]).includes('upstream request')),
    'error was called for connection failure',
  )
})

// ---------------------------------------------------------------------------
// Aborted request → logger.debug called with "upstream request aborted"
// The #aborted flag is set when the user-side abort callback (passed to
// handler.onConnect) is called explicitly — not via an AbortController signal.
// ---------------------------------------------------------------------------

test('log: user-triggered abort calls logger.debug with "upstream request aborted"', async (t) => {
  t.plan(2)
  const logger = makeMockLogger()
  const dispatch = compose(new undici.Agent(), interceptors.log())

  const server = await startServer((req, res) => {
    res.writeHead(200)
    res.end()
  })
  t.teardown(server.close.bind(server))

  let receivedError = null

  await new Promise((resolve) => {
    dispatch(
      {
        origin: `http://127.0.0.1:${server.address().port}`,
        path: '/',
        method: 'GET',
        headers: {},
        logger,
      },
      {
        onConnect(abort) {
          // Immediately call the abort callback — this sets log handler's #aborted flag.
          abort(new Error('user cancelled'))
        },
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          resolve()
        },
        onError(err) {
          receivedError = err
          resolve()
        },
      },
    )
  })

  t.ok(receivedError, 'onError was called')
  t.ok(
    logger.calls.debug.some((args) => String(args[args.length - 1]).includes('aborted')),
    'debug called for user-triggered abort',
  )
})

// ---------------------------------------------------------------------------
// logOpts.bindings are added to the child logger
// ---------------------------------------------------------------------------

test('log: logOpts.bindings are forwarded to the child logger', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    res.writeHead(200)
    res.end()
  })
  t.teardown(server.close.bind(server))

  let childCalledWithBindings = false
  const logger = {
    debug() {},
    warn() {},
    error() {},
    child(bindings) {
      // The first child() is called with { ureq: opts }
      return {
        debug() {},
        warn() {},
        error() {},
        child(b) {
          // The second child() is called with logOpts.bindings
          if (b && b.service === 'test-service') {
            childCalledWithBindings = true
          }
          return {
            debug() {},
            warn() {},
            error() {},
            child() {
              return this
            },
          }
        },
      }
    },
  }

  const dispatch = compose(
    new undici.Agent(),
    interceptors.log({ bindings: { service: 'test-service' } }),
  )
  await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: {},
    logger,
  })
  t.ok(childCalledWithBindings, 'bindings forwarded to child logger')
})
