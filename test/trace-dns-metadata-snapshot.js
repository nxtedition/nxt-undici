import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'
import { request } from '../lib/request.js'

test('background DNS refresh snapshots request trace metadata', async (t) => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  t.teardown(() => {
    Date.now = originalNow
  })

  const docs = []
  const trace = {
    write(doc, op) {
      docs.push({ ...doc, op })
    },
  }
  let lookupCount = 0
  let releaseRefresh
  const lookup = (_hostname, _opts, callback) => {
    lookupCount++
    if (lookupCount === 1) {
      callback(null, [{ address: '127.0.0.1' }])
    } else {
      releaseRefresh = () => callback(null, [{ address: '127.0.0.1' }])
    }
  }
  let dispatchCount = 0
  const dispatch = compose(
    (_opts, handler) => {
      dispatchCount++
      handler.onConnect(() => {})
      if (dispatchCount === 1) {
        handler.onHeaders(200, { 'content-length': '0' }, () => {})
        handler.onComplete({})
      } else {
        handler.onError(new Error('stop after starting refresh'))
      }
    },
    interceptors.dns(),
    interceptors.responseRetry(),
    interceptors.log(),
  )
  const dns = { ttl: 1000, lookup }

  const first = await request(dispatch, {
    id: 'req-prime',
    method: 'GET',
    origin: 'http://refresh.test',
    path: '/prime',
    dns,
    retry: false,
    trace,
  })
  await first.body.dump()

  now += 600

  await t.rejects(
    request(dispatch, {
      id: 'req-refresh',
      method: 'GET',
      origin: 'http://refresh.test',
      path: '/resource',
      dns,
      trace,
      retry(_err, _count, opts) {
        opts.id = 'req-mutated'
        opts.origin = 'http://mutated.test'
        opts.path = '/different'
        return false
      },
    }),
    /stop after starting refresh/,
  )

  t.equal(lookupCount, 2, 'the second request started a background refresh')
  t.type(releaseRefresh, 'function')
  releaseRefresh?.()
  await tick()

  const start = docs.find(
    (doc) => doc.op === 'undici:request' && doc.phase === 'start' && doc.id === 'req-refresh',
  )
  const refresh = docs.find((doc) => doc.op === 'undici:dns' && doc.source === 'refresh')

  t.ok(start, 'the triggering request start trace exists')
  t.ok(refresh, 'the refresh trace exists')
  if (!start || !refresh) {
    return
  }

  t.match(refresh, {
    id: start.id,
    url: start.url,
    source: 'refresh',
    records: 1,
    err: null,
  })
})
