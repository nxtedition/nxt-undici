// Regression tests for dns negative caching:
//  - a failed lookup is negative-cached for `negativeTTL` (default 1000 ms),
//    so a hot caller of an unresolvable host performs ONE underlying lookup
//    per window instead of one per request. Without this, response-retry
//    (which retries ENOTFOUND/EAI_AGAIN up to `retry` (default 8) times)
//    turned every logical request into ~9 dns.lookup calls — a lookup storm.
//  - the negative entry expires after negativeTTL; the next request performs
//    a fresh lookup and succeeds if DNS has recovered.
//  - each caller gets its OWN error object: decorateError call sites
//    (response-retry, response-error) mutate the error they receive
//    (err.req/err.res/err.statusCode), so handing the same cached object to
//    N callers would cross-contaminate their decorations.
import { test } from 'tap'
import { setTimeout as sleep } from 'node:timers/promises'
import { interceptors } from '../lib/index.js'

function run(dispatch, opts) {
  return new Promise((resolve, reject) => {
    dispatch(
      { path: '/', method: 'GET', headers: {}, ...opts },
      {
        onConnect() {},
        onHeaders(statusCode) {
          resolve(statusCode)
          return true
        },
        onData() {},
        onComplete() {},
        onError: reject,
      },
    )
  })
}

function makeNotFoundError(hostname) {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname,
  })
}

// ---------------------------------------------------------------------------
// 1. All requests inside the negativeTTL window share one underlying lookup.
// ---------------------------------------------------------------------------

test('dns: lookup failures are negative-cached (one lookup per window)', async (t) => {
  let lookups = 0
  const lookup = (hostname, options, callback) => {
    lookups++
    process.nextTick(callback, makeNotFoundError(hostname))
  }

  const dispatch = interceptors.dns()(() => {
    t.fail('dispatch must not be reached when lookup fails')
  })

  // Keep the window comfortably larger than the test's runtime.
  const dns = { negativeTTL: 5000, lookup }

  for (let i = 0; i < 5; i++) {
    const err = await run(dispatch, { origin: 'http://unresolvable.invalid', dns }).then(
      () => null,
      (err) => err,
    )
    t.ok(err, `request ${i} rejected`)
    t.equal(err.code, 'ENOTFOUND', `request ${i} rejection carries ENOTFOUND`)
  }

  t.equal(lookups, 1, 'exactly one underlying lookup for all requests in the window')
})

// ---------------------------------------------------------------------------
// 2. The negative entry expires; the next request re-resolves and recovers.
// ---------------------------------------------------------------------------

test('dns: negative entry expires after negativeTTL and the next lookup recovers', async (t) => {
  let lookups = 0
  let failing = true
  const lookup = (hostname, options, callback) => {
    lookups++
    if (failing) {
      process.nextTick(callback, makeNotFoundError(hostname))
    } else {
      process.nextTick(callback, null, [{ address: '127.0.0.1', family: 4 }])
    }
  }

  const origins = []
  const dispatch = interceptors.dns()((opts, handler) => {
    origins.push(opts.origin)
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  })

  const dns = { negativeTTL: 50, lookup }

  await t.rejects(
    run(dispatch, { origin: 'http://recovers.invalid', dns }),
    { code: 'ENOTFOUND' },
    'first request fails with ENOTFOUND',
  )
  t.equal(lookups, 1, 'first request performed the lookup')

  // DNS expiry uses the real millisecond clock; wait just past the 50 ms TTL.
  failing = false
  await sleep(75)

  const status = await run(dispatch, { origin: 'http://recovers.invalid', dns })
  t.equal(status, 200, 'request succeeds once DNS recovers')
  t.equal(lookups, 2, 'a fresh lookup was performed after the negative entry expired')
  t.equal(origins[0], 'http://127.0.0.1', 'recovered request dispatched to the resolved address')
})

// ---------------------------------------------------------------------------
// 3. Every rejection is a distinct object; mutating one (as decorateError
//    does downstream) must not leak into another caller's error or into the
//    cached original.
// ---------------------------------------------------------------------------

test('dns: each caller gets its own error object (no cross-contamination)', async (t) => {
  const original = makeNotFoundError('cached.invalid')
  const lookup = (hostname, options, callback) => {
    process.nextTick(callback, original)
  }

  const dispatch = interceptors.dns()(() => {
    t.fail('dispatch must not be reached when lookup fails')
  })

  const dns = { negativeTTL: 5000, lookup }
  const opts = { origin: 'http://cached.invalid', dns }

  // Concurrent callers share the in-flight resolve promise.
  const [err1, err2] = await Promise.all([
    run(dispatch, opts).then(
      () => null,
      (err) => err,
    ),
    run(dispatch, opts).then(
      () => null,
      (err) => err,
    ),
  ])
  // A later caller is served from the negative cache.
  const err3 = await run(dispatch, opts).then(
    () => null,
    (err) => err,
  )

  for (const [name, err] of [
    ['err1', err1],
    ['err2', err2],
    ['err3', err3],
  ]) {
    t.ok(err, `${name} rejected`)
    t.equal(err.code, 'ENOTFOUND', `${name} carries ENOTFOUND`)
    t.equal(err.hostname, 'cached.invalid', `${name} carries the hostname`)
    t.equal(err.cause, original, `${name} keeps the original as cause`)
    t.not(err, original, `${name} is not the cached original`)
  }

  t.not(err1, err2, 'concurrent callers get distinct objects')
  t.not(err2, err3, 'negative-cache hit gets a distinct object')
  t.not(err1, err3, 'all rejections are distinct objects')

  // Simulate the decorateError mutations performed by response-retry /
  // response-error on one caller's error.
  err1.statusCode = 503
  err1.req = { path: '/mutated' }
  err1.res = { statusCode: 503 }

  t.equal(err2.statusCode, undefined, 'sibling error is unaffected by mutation')
  t.equal(err2.req, undefined, 'sibling error req is unaffected')
  t.equal(err3.res, undefined, 'later error res is unaffected')
  t.equal(original.statusCode, undefined, 'cached original is unaffected')
  t.equal(original.req, undefined, 'cached original req is unaffected')
})
