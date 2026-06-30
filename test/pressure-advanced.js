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
    some: 0,
    full: 0,
    shed: false,
    paused: false,
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
  t.same(p.pressure('http://never.test'), { some: 0, full: 0, shed: false, paused: false })
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
