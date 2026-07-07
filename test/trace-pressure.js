import { test } from 'tap'
import tp from 'node:timers/promises'
import { interceptors } from '../lib/index.js'
import { installTrace } from '../lib/trace.js'

// The per-thread default writer slot (the legacy __nxt_lib_trace var is
// deprecated). Reads may go through the slot; installs must go through
// installTrace so the package's module-local mirror updates synchronously.
const kTrace = Symbol.for('@nxtedition/app/trace')

const ORIGIN = 'http://example.test'
const noopHandler = { onConnect() {}, onHeaders() {}, onData() {}, onComplete() {}, onError() {} }

// Same deterministic harness as test/pressure-advanced.js: a capturing dispatch
// stub instead of sockets, sampleInterval: 0 so the test drives sample() itself,
// and tau ≪ inter-sample dt so one sample sets the EWMA to the instantaneous
// "stalled?" bool — Schmitt-trigger crossings become deterministic.
function capturingDispatch() {
  const captured = []
  const dispatch = (opts, handler) => {
    captured.push(handler)
  }
  return { dispatch, captured }
}

function makeInterceptor(opts) {
  return interceptors.pressure({ sampleInterval: 0, tau: 0.001, ...opts })
}

// performance.now() must advance between samples or #sample short-circuits on
// dt <= 0; a 2ms real wait guarantees dt > 0 (and, with tiny tau, gain ≈ 1).
async function tick(interceptor) {
  await tp.setTimeout(2)
  interceptor.sample()
}

function makeWriter() {
  const docs = []
  return {
    docs,
    write(obj, op) {
      docs.push({ ...obj, op })
    },
  }
}

// Engage `some` (shed) only: A stays pending (standing backlog) while B
// completes within the window, so Δcompleted > 0 keeps `full` from engaging
// alongside it. Release by connecting A (see the callers).
function engageSome(wrapped, captured) {
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  captured[1].onConnect(() => {})
  captured[1].onComplete()
}

// ---------------------------------------------------------------------------
// some episode: start/end pair with correct shape
// ---------------------------------------------------------------------------

test('trace-pressure: some episode emits a start/end pair', async (t) => {
  const writer = makeWriter()
  const p = makeInterceptor({ trace: writer })
  t.teardown(() => p.close())
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  engageSome(wrapped, captured)
  await tick(p)
  t.ok(p.pressure(ORIGIN).shed, 'shed engaged')

  t.equal(writer.docs.length, 1, 'start doc on engage')
  const [start] = writer.docs
  t.match(start, {
    op: 'undici:pressure',
    origin: ORIGIN,
    level: 'some',
    phase: 'start',
    pending: 1,
    running: 0,
  })
  t.type(start.signal, 'number')
  t.ok(start.signal > 0.5, 'signal is the EWMA that tripped the gate')
  t.equal(start.signal, Math.round(start.signal * 1000) / 1000, 'signal rounded to 3 decimals')
  t.notOk('durationMs' in start, 'start doc carries no durationMs')

  // Drain the backlog (A connects) but keep it in-flight so the record is not
  // evicted before the release is observable.
  captured[0].onConnect(() => {})
  await tick(p)
  t.notOk(p.pressure(ORIGIN).shed, 'shed released')

  t.equal(writer.docs.length, 2, 'end doc on release')
  const end = writer.docs[1]
  t.match(end, {
    op: 'undici:pressure',
    origin: ORIGIN,
    level: 'some',
    phase: 'end',
    pending: 0,
    running: 1,
  })
  t.type(end.signal, 'number')
  t.type(end.durationMs, 'number')
  t.ok(end.durationMs >= 0)
  t.equal(end.durationMs, Math.round(end.durationMs), 'durationMs is rounded')
})

// ---------------------------------------------------------------------------
// level mapping: paused -> 'full', degraded -> 'error'
// ---------------------------------------------------------------------------

test('trace-pressure: paused maps to level full, degraded to level error', async (t) => {
  const writer = makeWriter()
  const p = makeInterceptor({ trace: writer })
  t.teardown(() => p.close())
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  // A standing backlog with zero completions engages both shed and paused.
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  await tick(p)
  t.ok(p.pressure(ORIGIN).paused, 'paused engaged')

  // Both release once the backlog connects and starts making progress.
  captured[0].onConnect(() => {})
  await tick(p)
  t.notOk(p.pressure(ORIGIN).paused, 'paused released')

  // A fast-but-failing completion engages degraded; healthy 200s release it.
  captured[0].onHeaders(503, {}, () => {})
  captured[0].onComplete()
  await tick(p)
  t.ok(p.pressure(ORIGIN).degraded, 'degraded engaged')

  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  wrapped({ origin: ORIGIN, path: '/' }, noopHandler)
  for (const h of captured.slice(1)) {
    h.onConnect(() => {})
    h.onHeaders(200, {}, () => {})
    h.onComplete()
  }
  await tick(p)
  t.notOk(p.pressure(ORIGIN).degraded, 'degraded released')

  t.same(
    writer.docs.map((d) => [d.level, d.phase]),
    [
      ['some', 'start'],
      ['full', 'start'],
      ['some', 'end'],
      ['full', 'end'],
      ['error', 'start'],
      ['error', 'end'],
    ],
    'each latch pairs under its own level keyword',
  )
  for (const doc of writer.docs) {
    t.equal(doc.op, 'undici:pressure')
    t.equal(doc.origin, ORIGIN)
    if (doc.phase === 'end') {
      t.type(doc.durationMs, 'number')
      t.ok(doc.durationMs >= 0)
    }
  }
})

// ---------------------------------------------------------------------------
// capture-once pairing: the global writer removed mid-episode
// ---------------------------------------------------------------------------

test('trace-pressure: pairing survives the global writer being removed mid-episode', async (t) => {
  const writer = makeWriter()
  const prev = globalThis[kTrace]
  installTrace(writer)
  t.teardown(() => {
    installTrace(prev)
  })

  // No trace option: undefined defers to the global writer at engage time.
  const p = makeInterceptor()
  t.teardown(() => p.close())
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  engageSome(wrapped, captured)
  await tick(p)
  t.equal(writer.docs.length, 1, 'start doc via the global writer')
  t.match(writer.docs[0], { op: 'undici:pressure', level: 'some', phase: 'start' })

  // Uninstall the global mid-episode AND null the writer's own write slot, so
  // any re-resolution is dead. The end doc can then only arrive through the
  // fn captured at engage.
  installTrace(undefined)
  writer.write = null

  captured[0].onConnect(() => {})
  await tick(p)

  t.equal(writer.docs.length, 2, 'end doc emitted via the captured fn')
  t.match(writer.docs[1], { op: 'undici:pressure', origin: ORIGIN, level: 'some', phase: 'end' })
  t.type(writer.docs[1].durationMs, 'number')
})

// ---------------------------------------------------------------------------
// trace: null disables; a mid-episode toggle-on emits no orphan end doc
// ---------------------------------------------------------------------------

test('trace-pressure: trace null disables; a mid-episode toggle-on stays silent', async (t) => {
  const globalWriter = makeWriter()
  const prev = globalThis[kTrace]
  t.teardown(() => {
    installTrace(prev)
  })

  // trace: null disables even with a global writer installed.
  installTrace(globalWriter)
  {
    const p = makeInterceptor({ trace: null })
    t.teardown(() => p.close())
    const { dispatch, captured } = capturingDispatch()
    const wrapped = p(dispatch)

    engageSome(wrapped, captured)
    await tick(p)
    t.ok(p.pressure(ORIGIN).shed, 'episode engaged')
    captured[0].onConnect(() => {})
    await tick(p)
    t.notOk(p.pressure(ORIGIN).shed, 'episode released')
    t.equal(globalWriter.docs.length, 0, 'trace: null emitted nothing')
  }

  // Engaging with no writer installed, then installing one mid-episode, must
  // not emit an end doc for a start that was never traced.
  installTrace(undefined)
  {
    const p = makeInterceptor()
    t.teardown(() => p.close())
    const { dispatch, captured } = capturingDispatch()
    const wrapped = p(dispatch)

    engageSome(wrapped, captured)
    await tick(p)
    t.ok(p.pressure(ORIGIN).shed, 'episode engaged silently')

    installTrace(globalWriter)
    captured[0].onConnect(() => {})
    await tick(p)
    t.notOk(p.pressure(ORIGIN).shed, 'episode released')
    t.equal(globalWriter.docs.length, 0, 'no orphaned end doc after a toggle-on')
  }
})

// ---------------------------------------------------------------------------
// close() mid-episode → engaged episodes are released, not orphaned
// ---------------------------------------------------------------------------

test('trace-pressure: close releases engaged episodes', async (t) => {
  const writer = makeWriter()
  const p = makeInterceptor({ trace: writer })
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  engageSome(wrapped, captured)
  await tick(p)
  t.equal(writer.docs.length, 1, 'start doc on engage')
  t.match(writer.docs[0], { level: 'some', phase: 'start' })

  // Teardown while the episode is engaged: a monitor close is not a hang, so
  // the pair must be completed instead of leaving a forever-open start doc.
  p.close()

  t.equal(writer.docs.length, 2, 'close emitted the end doc')
  t.match(writer.docs[1], { op: 'undici:pressure', origin: ORIGIN, level: 'some', phase: 'end' })
  t.type(writer.docs[1].durationMs, 'number')

  p.close()
  t.equal(writer.docs.length, 2, 'a second close does not double-emit')
})
