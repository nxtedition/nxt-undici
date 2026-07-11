import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import tp from 'node:timers/promises'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

const ORIGIN = 'http://example.test'
const noopHandler = { onConnect() {}, onHeaders() {}, onData() {}, onComplete() {}, onError() {} }

// A dispatch stub that captures the (wrapped) handler instead of doing any I/O,
// so a test can drive onConnect/onComplete/onError by hand and tick the EWMA
// loop deterministically via interceptor.sample().
function capturingDispatch() {
  const captured = []
  const dispatch = (opts, handler) => {
    captured.push(handler)
  }
  return { dispatch, captured }
}

// tau ≪ inter-sample dt ⇒ gain ≈ 1, so a single sample sets the EWMA to the
// instantaneous "stalled?" bool. Makes Schmitt-trigger crossings deterministic
// without depending on wall-clock smoothing. sampleInterval: 0 disables the
// internal timer; we drive sample() ourselves.
function makeInterceptor(opts) {
  return interceptors.pressure({ sampleInterval: 0, tau: 0.001, ...opts })
}

// performance.now() must advance between samples or #sample short-circuits on
// dt <= 0; a 2ms real wait guarantees dt > 0 (and, with tiny tau, gain ≈ 1).
async function tick(interceptor) {
  await tp.setTimeout(2)
  interceptor.sample()
}

// Drive a captured handler through a full successful lifecycle with a status.
function complete(handler, statusCode) {
  handler.onConnect(() => {})
  handler.onHeaders(statusCode, {}, () => {})
  handler.onComplete()
}

// ---------------------------------------------------------------------------
// accounting: pending -> running -> completed reconstructed from the lifecycle
// ---------------------------------------------------------------------------

test('pressure: reconstructs pending/running/completed gauges from the lifecycle', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  t.same(p.stats(ORIGIN), {
    pending: 1,
    running: 0,
    completed: 0,
    errored: 0,
    some: 0,
    full: 0,
    errorRate: 0,
    shed: false,
    paused: false,
    degraded: false,
  })

  captured[0].onConnect(() => {})
  t.match(p.stats(ORIGIN), { pending: 0, running: 1, completed: 0 })

  captured[0].onComplete()
  t.match(p.stats(ORIGIN), { pending: 0, running: 0, completed: 1 })

  p.close()
})

test('pressure: a request that errors before connecting still settles the gauge', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  t.match(p.stats(ORIGIN), { pending: 1, running: 0 })

  captured[0].onError(new Error('boom'))
  t.match(p.stats(ORIGIN), { pending: 0, running: 0, completed: 1 })

  p.close()
})

// ---------------------------------------------------------------------------
// healthy saturation scores 0: utilization is not the trigger
// ---------------------------------------------------------------------------

test('pressure: a busy-but-draining origin (no standing backlog) scores 0', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  // Five requests connect; four complete and one stays in-flight (so the record
  // is retained for inspection). The key point: pending returns to 0 — there is
  // no connection backlog — even though the origin is highly utilized.
  for (let i = 0; i < 5; i++) {
    wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  }
  for (const h of captured) h.onConnect(() => {})
  for (let i = 0; i < 4; i++) captured[i].onComplete()

  await tick(p)
  const s = p.stats(ORIGIN)
  t.match(s, { pending: 0, running: 1, completed: 4 }, 'busy: 1 in-flight, 4 done')
  t.equal(s?.some, 0, 'no connection backlog -> some stays 0')
  t.equal(s?.full, 0, 'progress was made -> full stays 0')
  t.notOk(s?.shed)
  t.notOk(s?.paused)

  p.close()
})

// ---------------------------------------------------------------------------
// some -> shed: a standing connection backlog sheds discretionary work only
// ---------------------------------------------------------------------------

test('pressure: a progressing backlog engages shed (not pause) and gates discretionary work', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  // A: a standing backlog (dispatched, never connects -> stays pending).
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  // B: completes within the window, so Δcompleted > 0 -> there IS forward
  // progress -> `full` (pause) must not engage, only `some` (shed).
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  captured[1].onConnect(() => {})
  captured[1].onComplete()

  await tick(p)

  const reading = p.pressure(ORIGIN)
  t.ok(reading.some > 0.5, 'some EWMA is high (backlog present)')
  t.ok(reading.shed, 'shed latched')
  t.notOk(reading.paused, 'not paused — work still completed this window')

  // some sheds discretionary work, but never normal/high priority traffic.
  t.ok(p.shouldBackoff(ORIGIN, 'low'), 'low priority is shed')
  t.ok(p.shouldBackoff(ORIGIN, 'lowest'), 'lowest priority is shed')
  t.notOk(p.shouldBackoff(ORIGIN, 'normal'), 'normal priority is not shed')
  t.notOk(p.shouldBackoff(ORIGIN, 'high'), 'high priority is not shed')
  t.notOk(p.shouldBackoff(ORIGIN), 'undirected work is not shed by `some` alone')

  p.close()
})

// ---------------------------------------------------------------------------
// full -> pause: backlog with zero progress pauses everything
// ---------------------------------------------------------------------------

test('pressure: a backlog making zero progress engages pause for all priorities', async (t) => {
  const p = makeInterceptor()
  const { dispatch } = capturingDispatch()
  const wrapped = p(dispatch)

  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)

  // Sample twice with no completions in between: Δcompleted === 0 -> full.
  await tick(p)
  await tick(p)

  const reading = p.pressure(ORIGIN)
  t.ok(reading.full > 0.3, 'full EWMA is high')
  t.ok(reading.paused, 'paused latched')

  // pause stops everything, regardless of priority.
  t.ok(p.shouldBackoff(ORIGIN, 'high'), 'high priority paused')
  t.ok(p.shouldBackoff(ORIGIN, 'low'), 'low priority paused')
  t.ok(p.shouldBackoff(ORIGIN), 'undirected work paused')

  p.close()
})

// ---------------------------------------------------------------------------
// hysteresis: the latch releases on recovery (engage high, release low)
// ---------------------------------------------------------------------------

test('pressure: shed releases once the backlog drains (record retained while in-flight)', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  await tick(p)
  t.ok(p.pressure(ORIGIN).shed, 'shed engaged under backlog')

  // Connect (pending -> running): the backlog is gone but the request is still
  // in-flight, so the record is NOT evicted — lets us observe the release.
  captured[0].onConnect(() => {})
  await tick(p)

  t.notOk(p.pressure(ORIGIN).shed, 'shed released after backlog drained')
  t.match(p.stats(ORIGIN), { pending: 0, running: 1 }, 'record retained while running')

  p.close()
})

// ---------------------------------------------------------------------------
// eviction: an idle, decayed origin is dropped so the map doesn't grow forever
// ---------------------------------------------------------------------------

test('pressure: a fully idle, decayed origin is evicted', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  captured[0].onConnect(() => {})
  captured[0].onComplete()

  await tick(p)
  t.equal(p.stats(ORIGIN), undefined, 'evicted once idle and decayed')
  t.same(p.stats(), [], 'no origins tracked')

  p.close()
})

// ---------------------------------------------------------------------------
// untracked origins: never under pressure
// ---------------------------------------------------------------------------

test('pressure: untracked origin reports no pressure', async (t) => {
  const p = makeInterceptor()
  t.same(p.pressure('http://never.test'), {
    some: 0,
    full: 0,
    errorRate: 0,
    shed: false,
    paused: false,
    degraded: false,
  })
  t.equal(p.stats('http://never.test'), undefined)
  t.notOk(p.shouldBackoff('http://never.test', 'low'))
  p.close()
})

// ---------------------------------------------------------------------------
// no origin: pass through untouched, track nothing
// ---------------------------------------------------------------------------

test('pressure: a request without an origin is passed through and not tracked', async (t) => {
  const p = makeInterceptor()
  let sawHandler = null
  const wrapped = p((opts, handler) => {
    sawHandler = handler
  })

  wrapped({ path: '/' }, noopHandler)
  t.equal(sawHandler, noopHandler, 'original handler forwarded unwrapped')
  t.same(p.stats(), [], 'nothing tracked')
  p.close()
})

// ---------------------------------------------------------------------------
// dispatch throwing synchronously still settles the gauge
// ---------------------------------------------------------------------------

test('pressure: a synchronous dispatch throw settles the pending gauge', async (t) => {
  const p = makeInterceptor()
  let errored = null
  const handler = { ...noopHandler, onError: (err) => (errored = err) }
  const wrapped = p(() => {
    throw new Error('sync boom')
  })

  wrapped({ origin: ORIGIN, path: '/' }, handler)
  t.ok(errored, 'error forwarded to handler.onError')
  t.match(p.stats(ORIGIN), { pending: 0, running: 0, completed: 1 }, 'gauge settled')
  p.close()
})

// ---------------------------------------------------------------------------
// an invalid handler throws without wedging the origin under pressure
// ---------------------------------------------------------------------------

test('pressure: an invalid handler throws without leaking the pending gauge', async (t) => {
  const p = makeInterceptor()
  const { dispatch } = capturingDispatch()
  const wrapped = p(dispatch)

  // DecoratorHandler rejects a non-object handler — the throw must propagate and
  // leave no phantom pending count (which would peg the origin under `some`).
  t.throws(() => wrapped({ origin: ORIGIN, path: '/' }, null), 'invalid handler rejected')

  const s = p.stats(ORIGIN)
  t.ok(s == null || s.pending === 0, 'pending gauge not leaked')
  await tick(p)
  t.equal(p.stats(ORIGIN), undefined, 'empty record evicted on the next idle tick')

  p.close()
})

// ---------------------------------------------------------------------------
// error pressure: a fast-but-failing origin (5xx/429) engages `degraded`
// ---------------------------------------------------------------------------

test('pressure: a burst of overload errors (5xx) engages degraded without backlog or pause', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  // Three requests that connect and complete *quickly* — no backlog, full
  // progress — but every one is a 503. Pure latency/backlog pressure stays 0.
  for (let i = 0; i < 3; i++) wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  for (const h of captured) complete(h, 503)

  await tick(p)
  const r = p.pressure(ORIGIN)
  t.equal(r.some, 0, 'no connection backlog')
  t.equal(r.full, 0, 'work completed — not stalled')
  t.ok(r.errorRate > 0.5, 'error-rate EWMA is high')
  t.ok(r.degraded, 'degraded latched')
  t.notOk(r.paused, 'not paused — the origin is responding, just failing')

  // degraded sheds discretionary work, like `some`.
  t.ok(p.shouldBackoff(ORIGIN, 'low'), 'low priority is shed')
  t.notOk(p.shouldBackoff(ORIGIN, 'normal'), 'normal priority is not shed')
  t.notOk(p.shouldBackoff(ORIGIN), 'undirected work is not shed by errors alone')

  p.close()
})

test('pressure: 429 counts as an overload error; 4xx client errors do not', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  wrapped({ origin: ORIGIN, path: '/' }, noopHandler) // 429 -> error
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler) // 404 -> not an error
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler) // 200 -> not an error
  complete(captured[0], 429)
  complete(captured[1], 404)
  complete(captured[2], 200)

  const s = p.stats(ORIGIN)
  t.equal(s?.completed, 3, 'all three completed')
  t.equal(s?.errored, 1, 'only the 429 is counted as an overload error')

  p.close()
})

test('pressure: a transport error counts; a client abort does not', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  // Transport failure (no status) -> counted.
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  captured[0].onConnect(() => {})
  captured[0].onError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))

  // Client-initiated abort -> not the origin's fault, not counted.
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  captured[1].onConnect(() => {})
  captured[1].onError(Object.assign(new Error('aborted'), { name: 'AbortError' }))

  const s = p.stats(ORIGIN)
  t.equal(s?.completed, 2, 'both settled')
  t.equal(s?.errored, 1, 'transport error counted, abort not')

  p.close()
})

test('pressure: degraded releases once responses recover', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  // Engage on a 503 burst.
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  complete(captured[0], 503)
  complete(captured[1], 503)
  await tick(p)
  t.ok(p.pressure(ORIGIN).degraded, 'degraded engaged on 5xx burst')

  // Keep one request in-flight so the record is retained, then complete two
  // healthy 200s — the error fraction this window is 0.
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  captured[2].onConnect(() => {})
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  complete(captured[3], 200)
  complete(captured[4], 200)
  await tick(p)

  t.notOk(p.pressure(ORIGIN).degraded, 'degraded released after healthy responses')
  t.match(p.stats(ORIGIN), { running: 1 }, 'record retained while in-flight')

  p.close()
})

test('pressure: a reconnect clears stale status so a later transport failure still counts', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  // One handler reconnected across attempts, as an upstream retry handler does.
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  const h = captured[0]
  h.onConnect(() => {})
  h.onHeaders(200, {}, () => {}) // attempt 1 captured a (non-error) success status
  h.onConnect(() => {}) // retry -> fresh attempt; captured status must reset
  h.onError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))

  // Without the per-connect reset, the stale 200 would mask the transport
  // failure (200 -> not an error) and errored would be 0.
  t.match(
    p.stats(ORIGIN),
    { completed: 1, errored: 1 },
    'transport failure counted, not masked by the prior attempt status',
  )

  p.close()
})

// ---------------------------------------------------------------------------
// integration: composed in front of a real dispatcher
// ---------------------------------------------------------------------------

test('pressure: composes with a real dispatcher and observes a real request', async (t) => {
  const server = createServer((req, res) => res.end('ok'))
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const origin = `http://127.0.0.1:${server.address().port}`
  // Internal timer enabled here (default) — exercise the real sampling loop.
  const p = interceptors.pressure()
  t.teardown(() => p.close())

  const dispatch = compose(new undici.Agent(), p)

  const statusCode = await new Promise((resolve, reject) => {
    let sc
    dispatch(
      { origin, path: '/', method: 'GET', headers: {} },
      {
        onConnect() {},
        onHeaders(s) {
          sc = s
          return true
        },
        onData() {},
        onComplete() {
          resolve(sc)
        },
        onError: reject,
      },
    )
  })

  t.equal(statusCode, 200)
  const s = p.stats(origin)
  t.ok(s == null || s.completed >= 1, 'the completed request was accounted for')
})
