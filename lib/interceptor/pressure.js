import { parsePriority, Scheduler } from '@nxtedition/scheduler'
import { DecoratorHandler } from '../utils.js'

// Reconstruct a PSI-style pressure signal per origin from the request lifecycle
// this interceptor observes, then expose latched flags so producers can back
// off. See @nxtedition/scheduler's README ("Pressure & backoff: utilization is
// the wrong trigger"): a resource can be 100% utilized with ~0 pressure — what
// you must throttle on is the fraction of time runnable work is *stalled*, not
// how busy you are.
//
// The HTTP analogue of the scheduler's `pending > 0 && saturated` is simply
// `pending > 0`: undici leaves a request un-connected (`pending`, in our
// accounting: dispatched but no `onConnect` yet) *only* when it has no free
// connection slot to place it on. The instant a slot frees, the queued request
// connects. So a standing `pending > 0` already means "backlog AND no free
// capacity" — a busy-but-keeping-up origin drains `pending` back to 0 between
// samples and scores 0, exactly the healthy-saturation false positive the naive
// `running/concurrency` recipe fires on.
//
//  - some (PSI "some"): at least one request waiting for a connection -> shed
//    discretionary work.
//  - full (PSI "full"): a backlog AND zero completions this window -> nothing is
//    making progress (origin hung / all sockets stuck) -> pause the producer.
//
// Two independent defenses give "sensitive to real overload, not so twitchy it
// flaps": the predicate filters healthy saturation before it enters the signal,
// and the EWMA window + Schmitt-trigger dead-band (engage high, release low) is
// the oomd-style sustained-duration requirement.
//
// PSI measures *stall* (latency) pressure; an HTTP origin has a second failure
// mode the latency signal is blind to: responding *fast* but *failing*. A flood
// of 503/429 drains `pending` and ticks `completed`, so neither `some` nor
// `full` fires — yet it is exactly when you should back off. So we add a third,
// HTTP-specific tier alongside the two PSI levels:
//
//  - errorRate (EWMA of the fraction of completions that were overload errors:
//    429/420 or 5xx, plus transport failures) -> `degraded` -> shed
//    discretionary work, same tier as `some`. (A *rate*, not a per-tick bool, so
//    a trickle of errors under heavy traffic doesn't latch.) The `peer.dns`
//    interceptor already tracks 5xx per resolved IP for load balancing; this is
//    the same insight applied at the logical-origin level for backoff.

const EPS = 1e-3

// Overload-shaped response statuses: explicit rate limits (429/420) and server
// errors (5xx). 4xx client errors (404, 400, 401, …) are NOT origin pressure —
// they don't mean the origin is struggling — so they don't count.
function isErrorStatus(statusCode) {
  return statusCode === 429 || statusCode === 420 || statusCode >= 500
}

// Smallest priority that is still "discretionary" — sheddable under `some`
// pressure. low/lower/lowest (<= -1); normal and above are never shed.
function isDiscretionary(priority) {
  if (priority == null) {
    return false
  }
  try {
    return parsePriority(priority) <= Scheduler.LOW
  } catch {
    return false
  }
}

class PressureMonitor {
  #origins = new Map()
  /** @type {ReturnType<typeof setInterval> | null} */
  #timer = null

  #sampleInterval
  #tau
  #someHi
  #someLo
  #fullHi
  #fullLo
  #errHi
  #errLo

  constructor({
    sampleInterval = 200,
    tau = 10_000,
    someHi = 0.5,
    someLo = 0.2,
    fullHi = 0.3,
    fullLo = 0.1,
    errHi = 0.5,
    errLo = 0.2,
  } = {}) {
    this.#sampleInterval = sampleInterval
    this.#tau = tau
    this.#someHi = someHi
    this.#someLo = someLo
    this.#fullHi = fullHi
    this.#fullLo = fullLo
    this.#errHi = errHi
    this.#errLo = errLo
  }

  // Called from the interceptor on each dispatch to get (or lazily create) the
  // per-origin record the handler mutates as the request progresses. The
  // `pending` increment is done by the Handler constructor, not here, so it is
  // tied to a *successfully* constructed handler: a handler that fails
  // validation (DecoratorHandler throws on a non-object handler) never leaves a
  // phantom pending count wedging the origin under pressure. A record created
  // here but never incremented is harmless — it reports no pressure and is
  // evicted on the next idle tick.
  track(key) {
    let rec = this.#origins.get(key)
    if (rec == null) {
      rec = {
        pending: 0, // gauge: dispatched, awaiting onConnect (waiting for a slot)
        running: 0, // gauge: connected and in-flight
        completed: 0, // counter: cumulative settled (onComplete + onError)
        errored: 0, // counter: cumulative settled with an overload error
        prevCompleted: 0, // snapshot of `completed` at the previous sample
        prevErrored: 0, // snapshot of `errored` at the previous sample
        some: 0, // EWMA: fraction of recent time `someNow` held
        full: 0, // EWMA: fraction of recent time `fullNow` held
        errorRate: 0, // EWMA: smoothed fraction of completions that errored
        shed: false, // latched: shed discretionary work
        paused: false, // latched: pause the producer
        degraded: false, // latched: error rate too high
        lastSample: performance.now(),
      }
      this.#origins.set(key, rec)
    }
    this.#ensureTimer()
    return rec
  }

  // One sample -> instantaneous "stalled right now?" per level, smoothed into
  // loadavg-shaped EWMAs with a dt-aware gain (keeps the time-constant honest
  // under a jittery loop). Counters (completed) carry the `full` decision so a
  // burst that fills and drains between two samples can't alias it away.
  #sample(rec, now) {
    const dt = now - rec.lastSample
    if (dt <= 0) {
      return
    }
    rec.lastSample = now

    const dCompleted = rec.completed - rec.prevCompleted
    const dErrored = rec.errored - rec.prevErrored
    const someNow = rec.pending > 0
    const fullNow = someNow && dCompleted === 0
    // Error *fraction* this window — a rate, so volume doesn't matter. No
    // completions this window (idle, or hung — `full` covers that) means no new
    // error evidence, so the signal relaxes toward 0.
    const errNow = dCompleted > 0 ? dErrored / dCompleted : 0
    rec.prevCompleted = rec.completed
    rec.prevErrored = rec.errored

    const a = 1 - Math.exp(-dt / this.#tau)
    rec.some += a * ((someNow ? 1 : 0) - rec.some)
    rec.full += a * ((fullNow ? 1 : 0) - rec.full)
    rec.errorRate += a * (errNow - rec.errorRate)

    // Hysteresis: engage high, release low.
    if (!rec.shed && rec.some > this.#someHi) {
      rec.shed = true
    } else if (rec.shed && rec.some < this.#someLo) {
      rec.shed = false
    }
    if (!rec.paused && rec.full > this.#fullHi) {
      rec.paused = true
    } else if (rec.paused && rec.full < this.#fullLo) {
      rec.paused = false
    }
    if (!rec.degraded && rec.errorRate > this.#errHi) {
      rec.degraded = true
    } else if (rec.degraded && rec.errorRate < this.#errLo) {
      rec.degraded = false
    }
  }

  // Tick every tracked origin, then evict any that is fully idle and has decayed
  // back to ~0 on both levels, so a client touching many origins doesn't
  // accumulate records forever. Stop the timer once nothing is tracked.
  #tick() {
    const now = performance.now()
    for (const [key, rec] of this.#origins) {
      this.#sample(rec, now)
      if (
        rec.pending === 0 &&
        rec.running === 0 &&
        rec.some < EPS &&
        rec.full < EPS &&
        rec.errorRate < EPS
      ) {
        this.#origins.delete(key)
      }
    }
    if (this.#origins.size === 0 && this.#timer != null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  #ensureTimer() {
    if (this.#timer == null && this.#sampleInterval > 0 && this.#origins.size > 0) {
      this.#timer = setInterval(() => this.#tick(), this.#sampleInterval)
      // Never keep the event loop alive just to sample — the producer's own
      // activity is what matters.
      this.#timer.unref?.()
    }
  }

  // Manual tick, for callers that disable the internal timer (sampleInterval: 0)
  // and drive sampling from a loop they already run (health check, metrics
  // scrape) — the scheduler README's preferred "the loop is YOURS" pattern.
  sample() {
    this.#tick()
  }

  #snapshot(rec) {
    return {
      pending: rec.pending,
      running: rec.running,
      completed: rec.completed,
      errored: rec.errored,
      some: rec.some,
      full: rec.full,
      errorRate: rec.errorRate,
      shed: rec.shed,
      paused: rec.paused,
      degraded: rec.degraded,
    }
  }

  // No arg -> array of { origin, ...snapshot } for every tracked origin (a
  // metrics scrape). With an origin -> that origin's snapshot, or undefined if
  // it isn't being tracked (never seen, or evicted after going idle).
  stats(origin) {
    if (origin == null) {
      const out = []
      for (const [key, rec] of this.#origins) {
        out.push({ origin: key, ...this.#snapshot(rec) })
      }
      return out
    }
    const rec = this.#origins.get(origin)
    return rec ? this.#snapshot(rec) : undefined
  }

  // The smoothed pressure for an origin. An untracked origin is, by definition,
  // not under pressure.
  pressure(origin) {
    const rec = this.#origins.get(origin)
    return rec
      ? {
          some: rec.some,
          full: rec.full,
          errorRate: rec.errorRate,
          shed: rec.shed,
          paused: rec.paused,
          degraded: rec.degraded,
        }
      : { some: 0, full: 0, errorRate: 0, shed: false, paused: false, degraded: false }
  }

  // Producer-side gate mirroring the README's `submit` recipe: `full` pauses
  // everything; `some` (backlog) or `degraded` (error rate) sheds only
  // discretionary (low-priority) work.
  shouldBackoff(origin, priority) {
    const rec = this.#origins.get(origin)
    if (rec == null) {
      return false
    }
    if (rec.paused) {
      return true
    }
    if (rec.shed || rec.degraded) {
      return isDiscretionary(priority)
    }
    return false
  }

  close() {
    if (this.#timer != null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    this.#origins.clear()
  }

  [Symbol.dispose]() {
    this.close()
  }
}

class Handler extends DecoratorHandler {
  #rec
  // 'pending' (awaiting onConnect) -> 'running' (connected) -> 'done' (settled).
  // Tracked here so each transition fires exactly once regardless of how many
  // times onConnect is invoked (e.g. a retry handler upstream) or which
  // terminal callback fires.
  #state = 'pending'
  #statusCode = 0

  constructor(handler, rec) {
    // super() validates the handler and throws on a non-object before we touch
    // the gauge, so a rejected handler can't leak a pending count.
    super(handler)
    this.#rec = rec
    rec.pending += 1
  }

  onConnect(abort) {
    if (this.#state === 'pending') {
      this.#state = 'running'
      this.#rec.pending -= 1
      this.#rec.running += 1
    }
    super.onConnect(abort)
  }

  onHeaders(statusCode, headers, resume) {
    // Latest status wins, so an informational 1xx is superseded by the final
    // response. Read at onComplete to classify the outcome.
    this.#statusCode = statusCode
    return super.onHeaders(statusCode, headers, resume)
  }

  onComplete(trailers) {
    this.#settle(isErrorStatus(this.#statusCode))
    super.onComplete(trailers)
  }

  onError(err) {
    // A status-bearing error is `responseError`'s decorated 4xx/5xx (when this
    // interceptor sits outside it); classify by that status. A status-less
    // error is a transport/connection failure (ECONNREFUSED, timeout, a sync
    // dispatch throw) — count it, unless it's a client-initiated abort.
    const statusCode = err?.statusCode ?? this.#statusCode
    const isError =
      err?.name === 'AbortError' ? false : statusCode >= 200 ? isErrorStatus(statusCode) : true
    this.#settle(isError)
    super.onError(err)
  }

  #settle(isError) {
    if (this.#state === 'done') {
      return
    }
    if (this.#state === 'pending') {
      this.#rec.pending -= 1
    } else {
      this.#rec.running -= 1
    }
    this.#rec.completed += 1
    if (isError) {
      this.#rec.errored += 1
    }
    this.#state = 'done'
  }
}

export default (opts) => {
  const monitor = new PressureMonitor(opts)

  const interceptor = (dispatch) => (opts, handler) => {
    if (!opts.origin) {
      return dispatch(opts, handler)
    }

    // Key on opts.origin — the logical origin the caller knows and queries by.
    // Compose this interceptor *ahead of* (outer to) `dns()` so opts.origin is
    // still the logical host rather than a rotating resolved IP.
    const key = opts.origin

    const rec = monitor.track(key)
    // Construct before the try: a handler that fails validation throws straight
    // to the caller (as with any DecoratorHandler-based interceptor) and, since
    // the constructor increments `pending` only on success, leaks nothing.
    const pressureHandler = new Handler(handler, rec)

    try {
      return dispatch(opts, pressureHandler)
    } catch (err) {
      pressureHandler.onError(err)
    }
  }

  // The monitor is owned by the interceptor instance; surface its read API on
  // the composed function so callers hold a single handle.
  interceptor.stats = (origin) => monitor.stats(origin)
  interceptor.pressure = (origin) => monitor.pressure(origin)
  interceptor.shouldBackoff = (origin, priority) => monitor.shouldBackoff(origin, priority)
  interceptor.sample = () => monitor.sample()
  interceptor.close = () => monitor.close()
  interceptor[Symbol.dispose] = () => monitor.close()

  return interceptor
}
