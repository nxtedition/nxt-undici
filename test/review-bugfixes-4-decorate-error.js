import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request } from '../lib/index.js'

// ---------------------------------------------------------------------------
// Regression: decorateError used to mutate the error object it was given in
// place. When one AbortController aborts N in-flight requests, signal.reason
// is a SINGLE shared object — every request's error path decorated the SAME
// instance (last writer wins), so request /one's rejection reported
// err.req.path === '/two', and the caller's own reason object permanently
// gained req/res properties.
// ---------------------------------------------------------------------------

test('abort: shared abort reason is not mutated or cross-contaminated', async (t) => {
  let pending = 2
  let onBothInFlight
  const bothInFlight = new Promise((resolve) => {
    onBothInFlight = resolve
  })

  const server = createServer(() => {
    // Never respond — keep both requests in flight.
    if (--pending === 0) {
      onBothInFlight()
    }
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const origin = `http://127.0.0.1:${server.address().port}`
  const ac = new AbortController()
  const reason = new Error('shared abort reason')

  const p1 = request(`${origin}/one`, { signal: ac.signal, retry: false, headersTimeout: 30000 })
  const p2 = request(`${origin}/two`, { signal: ac.signal, retry: false, headersTimeout: 30000 })

  await bothInFlight
  ac.abort(reason)

  const [r1, r2] = await Promise.allSettled([p1, p2])
  t.equal(r1.status, 'rejected', 'first request rejects')
  t.equal(r2.status, 'rejected', 'second request rejects')

  // The rejection must be the exact caller-owned reason, untouched.
  t.equal(r1.reason, reason, 'first rejection is the exact abort reason')
  t.equal(r2.reason, reason, 'second rejection is the exact abort reason')

  // One request's decoration must never leak into another request's
  // rejection (previously both reported req.path === '/two').
  t.not(r1.reason?.req?.path, '/two', 'rejection for /one must not report /two')
  t.not(r2.reason?.req?.path, '/one', 'rejection for /two must not report /one')

  // The caller's reason object must not gain req/res/statusCode properties.
  t.equal('req' in reason, false, 'reason must not gain req')
  t.equal('res' in reason, false, 'reason must not gain res')
  t.equal('statusCode' in reason, false, 'reason must not gain statusCode')
})

test('abort: default (reason-less) abort is shared per signal and not mutated', async (t) => {
  let pending = 2
  let onBothInFlight
  const bothInFlight = new Promise((resolve) => {
    onBothInFlight = resolve
  })

  const server = createServer(() => {
    if (--pending === 0) {
      onBothInFlight()
    }
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const origin = `http://127.0.0.1:${server.address().port}`
  const ac = new AbortController()

  const p1 = request(`${origin}/one`, { signal: ac.signal, retry: false, headersTimeout: 30000 })
  const p2 = request(`${origin}/two`, { signal: ac.signal, retry: false, headersTimeout: 30000 })

  await bothInFlight
  ac.abort()

  const [r1, r2] = await Promise.allSettled([p1, p2])
  t.equal(r1.status, 'rejected', 'first request rejects')
  t.equal(r2.status, 'rejected', 'second request rejects')

  // The default DOMException reason is also a single object shared by every
  // request on the signal — it must not gain req/res either.
  t.equal('req' in ac.signal.reason, false, 'signal.reason must not gain req')
  t.equal('res' in ac.signal.reason, false, 'signal.reason must not gain res')
})

test('response-error: 4xx errors are still decorated with statusCode/req/res', async (t) => {
  const server = createServer((req, res) => {
    res.statusCode = 418
    res.end('teapot')
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  try {
    await request(`http://127.0.0.1:${server.address().port}/tea`, { retry: false })
    t.fail('should have thrown')
  } catch (err) {
    t.equal(err.statusCode, 418, 'statusCode still decorated')
    t.equal(err.req.path, '/tea', 'req still decorated')
    t.ok(err.res, 'res still decorated')
  }
})

test('response-error: network errors are still decorated with req info', async (t) => {
  const server = createServer((req, res) => {
    res.destroy()
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  try {
    await request(`http://127.0.0.1:${server.address().port}/api`, { retry: false })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.req, 'err.req is set on network error')
    t.equal(err.req.path, '/api', 'req.path still decorated on network error')
  }
})
