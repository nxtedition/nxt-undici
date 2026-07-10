/* eslint-disable */
// Regression tests for the 2026-07 cache deep-review fixes (small confirmed
// bugs):
// - makeKey merges case-duplicate header names (last-wins hid a value from
//   Vary selectors and the request-directive guards).
// - makeKey fails fast when opts.query is combined with a '?'-bearing path
//   (a cache hit previously masked the InvalidArgumentError undici throws).
// - invalidation resolves Location against buildURL(origin, path), so a
//   request path starting with '//' can no longer swap the base authority
//   (missed same-origin invalidations / wrong-path deletes).
// - a 206 with the grammar-invalid open-ended Content-Range (bytes N-/M,
//   RFC 9110 §14.4 requires last-pos) is no longer stored.
// - serveFromCache honors the pause contract: onData/onComplete are deferred
//   while the handler is paused and delivered via the resume callback.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { makeKey } from '../lib/interceptor/cache/store.js'
import { serveFromCache } from '../lib/interceptor/cache/serve.js'
import { InvalidationHandler } from '../lib/interceptor/cache/invalidation-handler.js'
import { interceptors, compose } from '../lib/index.js'
import undici from '@nxtedition/undici'

test('makeKey merges case-duplicate header names instead of last-wins', (t) => {
  const key = makeKey({
    origin: 'https://example.com',
    method: 'GET',
    path: '/x',
    headers: { Accept: 'text/html', accept: 'application/json' },
  })
  t.strictSame(
    key.headers.accept,
    ['text/html', 'application/json'],
    'both wire header lines survive in the key',
  )
  t.end()
})

test("makeKey throws when opts.query is combined with a '?'-bearing path", (t) => {
  t.throws(
    () =>
      makeKey({
        origin: 'https://example.com',
        method: 'GET',
        path: '/x?a=1',
        query: { b: 2 },
      }),
    /Query params cannot be passed when url already contains/,
  )
  t.end()
})

test('invalidation: protocol-relative request path cannot swap the resolution base', (t) => {
  const deleted = []
  const store = {
    delete(key) {
      deleted.push(key.path)
    },
  }
  const recorded = { headers: null }
  const handler = {
    onConnect() {},
    onHeaders() {
      return true
    },
    onData() {
      return true
    },
    onComplete() {},
    onError() {},
  }
  const h = new InvalidationHandler(
    { origin: 'http://example.com', method: 'POST', path: '//api/items/1', headers: {} },
    { store, handler },
  )
  h.onConnect(() => {})
  // Absolute same-origin Location: pre-fix the base origin was read as
  // http://api (authority swapped from the path), so this was SKIPPED.
  h.onHeaders(200, { location: 'http://example.com/items/1' }, () => {})

  t.ok(deleted.includes('//api/items/1'), 'request URI invalidated')
  t.ok(deleted.includes('/items/1'), 'same-origin Location target invalidated')
  t.end()
})

test('206 with open-ended Content-Range (missing last-pos) is not stored', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(206, { 'content-range': 'bytes 15-/10', 'cache-control': 'max-age=60' })
    res.end('abc')
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(() => server.close())

  const sets = []
  const store = {
    get() {
      return undefined
    },
    set(key, value) {
      sets.push(value)
    },
  }
  const dispatch = compose(new undici.Agent(), interceptors.cache())
  await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: `http://0.0.0.0:${server.address().port}`,
        method: 'GET',
        path: '/x',
        headers: {},
        cache: { store },
      },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData() {
          return true
        },
        onComplete: resolve,
        onError: reject,
      },
    )
  })
  t.strictSame(sets, [], 'grammar-invalid Content-Range not stored')
  t.end()
})

test('serveFromCache defers delivery while the handler is paused', (t) => {
  const events = []
  let savedResume
  const entry = {
    statusCode: 200,
    headers: { 'cache-control': 'max-age=60' },
    body: Buffer.from('hello'),
    cachedAt: Date.now(),
  }

  // Pause at onHeaders: no data/complete until resume().
  serveFromCache(
    entry,
    {},
    {
      onConnect() {},
      onHeaders(sc, h, resume) {
        events.push('headers')
        savedResume = resume
        return false
      },
      onData(chunk) {
        events.push(`data:${chunk}`)
        return true
      },
      onComplete() {
        events.push('complete')
      },
      onError(err) {
        events.push(`error:${err.message}`)
      },
    },
  )
  t.strictSame(events, ['headers'], 'paused at headers: nothing delivered yet')
  savedResume()
  t.strictSame(events, ['headers', 'data:hello', 'complete'], 'resume drives the rest')

  // Pause at onData: onComplete deferred until resume().
  const events2 = []
  let resume2
  serveFromCache(
    entry,
    {},
    {
      onConnect() {},
      onHeaders(sc, h, resume) {
        resume2 = resume
        events2.push('headers')
        return true
      },
      onData(chunk) {
        events2.push('data')
        return false
      },
      onComplete() {
        events2.push('complete')
      },
      onError() {},
    },
  )
  t.strictSame(events2, ['headers', 'data'], 'paused at data: complete deferred')
  resume2()
  t.strictSame(events2, ['headers', 'data', 'complete'], 'resume delivers completion')
  t.end()
})
