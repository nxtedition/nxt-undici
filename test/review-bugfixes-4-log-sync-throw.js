/* eslint-disable */
import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

const kGlobalArray = Symbol.for('@nxtedition/nxt-undici#globalArray')

function globalArrayLength() {
  return globalThis[kGlobalArray]?.length ?? 0
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
    child() {
      return logger
    },
  }
  return logger
}

// ---------------------------------------------------------------------------
// An inner interceptor that throws synchronously at dispatch time must not
// leave the log handler registered in the global in-flight registry forever.
// ---------------------------------------------------------------------------

test('log: handler deregisters when an inner interceptor throws at dispatch time', async (t) => {
  t.plan(8)

  const boom = () => (dispatch) => (opts, handler) => {
    throw new Error('boom')
  }

  const logger = makeMockLogger()
  const dispatch = compose(new undici.Agent(), boom(), interceptors.log())

  const before = globalArrayLength()

  for (let i = 0; i < 3; i++) {
    t.throws(
      () =>
        dispatch(
          { origin: 'http://127.0.0.1:1', path: '/', method: 'GET', headers: {}, logger },
          {
            onConnect() {},
            onHeaders() {
              return true
            },
            onData() {},
            onComplete() {},
            onError() {},
          },
        ),
      /boom/,
      'sync dispatch throw is rethrown to the caller',
    )
  }

  t.equal(globalArrayLength(), before, 'no zombie handlers left in the global registry')
  t.equal(
    logger.calls.debug.filter((args) => String(args[args.length - 1]).includes('started')).length,
    3,
    'each request logged a start line',
  )
  t.equal(
    logger.calls.error.filter((args) => String(args[args.length - 1]).includes('failed')).length,
    3,
    'each start line got a terminal failure counterpart',
  )
  t.equal(
    logger.calls.error.filter((args) => args[0]?.err?.message === 'boom').length,
    3,
    'the original error is included in the failure log',
  )
  t.ok(
    logger.calls.error.every((args) => typeof args[0]?.elapsedTime === 'number'),
    'failure log records elapsed time',
  )
})

// ---------------------------------------------------------------------------
// With the outer lookup interceptor (as in the real pipeline), the request
// must reject with the original error, delivered exactly once — the log
// handler must only deregister, not forward a second onError.
// ---------------------------------------------------------------------------

test('log: sync dispatch throw under lookup rejects once and leaves no zombies', async (t) => {
  t.plan(4)

  const boom = () => (dispatch) => (opts, handler) => {
    throw new Error('boom')
  }

  const logger = makeMockLogger()
  const dispatch = compose(new undici.Agent(), boom(), interceptors.log(), interceptors.lookup())

  const before = globalArrayLength()

  let onErrorCalls = 0
  const err = await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://127.0.0.1:1',
        path: '/',
        method: 'GET',
        headers: {},
        logger,
        lookup: (origin) => origin,
      },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          reject(new Error('unexpected onComplete'))
        },
        onError(err) {
          onErrorCalls++
          resolve(err)
        },
      },
    )
  })

  // Give a microtask/turn for any erroneous double delivery to surface.
  await new Promise((resolve) => setImmediate(resolve))

  t.equal(err.message, 'boom', 'request fails with the original error')
  t.equal(onErrorCalls, 1, 'onError is delivered exactly once')
  t.equal(globalArrayLength(), before, 'no zombie handlers left in the global registry')
  t.ok(
    logger.calls.error.some((args) => String(args[args.length - 1]).includes('failed')),
    'failure was logged',
  )
})

// ---------------------------------------------------------------------------
// Real-world repro: proxy loop detection throws synchronously at dispatch
// time (inbound Via already names this proxy) — LoopDetected must propagate
// and the log handler must not leak.
// ---------------------------------------------------------------------------

test('log: proxy loop detection at dispatch time does not leak handlers', async (t) => {
  t.plan(3)

  const logger = makeMockLogger()
  const dispatch = compose(
    new undici.Agent(),
    interceptors.proxy(),
    interceptors.log(),
    interceptors.lookup(),
  )

  const before = globalArrayLength()

  const errors = await Promise.all(
    Array.from(
      { length: 3 },
      () =>
        new Promise((resolve, reject) => {
          dispatch(
            {
              origin: 'http://127.0.0.1:1',
              path: '/',
              method: 'GET',
              headers: { via: 'HTTP/1.1 myproxy' },
              proxy: { name: 'myproxy' },
              logger,
              lookup: (origin) => origin,
            },
            {
              onConnect() {},
              onHeaders() {
                return true
              },
              onData() {},
              onComplete() {
                reject(new Error('unexpected onComplete'))
              },
              onError: resolve,
            },
          )
        }),
    ),
  )

  t.ok(
    errors.every((err) => err.status === 508),
    'each request rejects with LoopDetected',
  )
  t.equal(globalArrayLength(), before, 'no zombie handlers left in the global registry')
  t.equal(
    logger.calls.error.filter((args) => String(args[args.length - 1]).includes('failed')).length,
    3,
    'each failure was logged',
  )
})
