import { Scheduler } from '@nxtedition/scheduler'
import { DecoratorHandler, parseURL } from '../utils.js'
import { traceWrite, traceSafe, traceUrl } from '../trace.js'

function canonicalOrigin(origin, host) {
  if (Array.isArray(origin)) {
    const origins = [...new Set(origin.map((value) => canonicalOrigin(value, host)))].toSorted()
    return origins.length === 1 ? origins[0] : JSON.stringify(origins)
  }

  const url = parseURL(origin)
  if (host != null) {
    try {
      return new URL(`${url.protocol}//${host}`).origin
    } catch {
      // Host is untrusted runtime input. If it is not a valid authority, use
      // the already-validated origin rather than letting a scheduling key
      // prevent the underlying dispatcher from handling the request.
    }
  }
  return url.origin
}

class Handler extends DecoratorHandler {
  #scheduler
  #onIdle
  #trace

  constructor(handler, scheduler, onIdle, trace) {
    super(handler)
    this.#scheduler = scheduler
    this.#onIdle = onIdle
    this.#trace = trace
  }

  onConnect(abort) {
    this.#release()
    super.onConnect(abort)
  }

  onComplete(trailers) {
    this.#release()
    super.onComplete(trailers)
  }

  onError(err) {
    this.#release()
    super.onError(err)
  }

  #release() {
    if (this.#scheduler) {
      const scheduler = this.#scheduler
      this.#scheduler = null

      // Slot-release timestamp is captured BEFORE release(): it synchronously
      // pumps queued dispatches, whose work must not inflate this request's
      // holdMs. Emission happens after release + eviction, inside the same
      // once-guard as release() (every terminal callback funnels here), so
      // the end doc cannot double-fire and the writer never observes a
      // handler that still holds the slot.
      const trace = this.#trace
      const released = trace !== null ? performance.now() : 0

      scheduler.release()
      this.#onIdle?.()

      if (trace !== null) {
        traceSafe(
          trace.write,
          {
            id: trace.id,
            key: trace.key,
            priority: trace.priority,
            phase: 'end',
            pending: null,
            waitMs: Math.round(trace.dispatched - trace.acquired),
            holdMs: Math.round(released - trace.dispatched),
          },
          'undici:priority',
        )
      }
    }
  }
}

export default () => (dispatch) => {
  const schedulers = new Map()

  return (opts, handler) => {
    if (opts.priority == null || !opts.origin) {
      return dispatch(opts, handler)
    }

    // Key on a canonical logical origin. An outer dns interceptor rewrites
    // opts.origin to a rotating resolved IP but preserves the logical authority
    // in Host; combine that authority with the rewritten origin's scheme so one
    // service shares a scheduler across IPs without conflating HTTP and HTTPS.
    // Canonical URL strings also make equivalent URL/URLObject instances share
    // instead of keying the Map by object identity.
    const host =
      typeof opts.headers?.host === 'string' && opts.headers.host ? opts.headers.host : null
    const key = canonicalOrigin(opts.origin, host)

    let scheduler = schedulers.get(key)
    if (!scheduler) {
      scheduler = new Scheduler({ concurrency: 1 })
      schedulers.set(key, scheduler)
    }

    // Evict a scheduler once it has fully drained, so a client touching many
    // distinct origins doesn't accumulate them forever. The `=== scheduler`
    // guard avoids deleting a freshly-created replacement; release() drains
    // pending synchronously, so running===0 && pending===0 here means idle.
    const onIdle = () => {
      if (schedulers.get(key) === scheduler && scheduler.running === 0 && scheduler.pending === 0) {
        schedulers.delete(key)
      }
    }

    // Trace state (op 'undici:priority') is resolved once per request:
    // capture-once keeps the queued/end pair on one writer, and when tracing
    // is off the cost is one property read — no clock reads, no string work.
    // `acquired` must be stamped BEFORE acquire(): a free slot invokes the
    // callback synchronously and `dispatched` would otherwise predate it.
    const write = traceWrite(opts.trace)
    const trace =
      write !== null
        ? {
            write,
            id: opts.id ?? null,
            key: traceUrl({ origin: key }),
            priority: String(opts.priority).slice(0, 16),
            acquired: performance.now(),
            dispatched: 0,
          }
        : null

    const priorityHandler = new Handler(handler, scheduler, onIdle, trace)
    let dispatchResult
    const acquired = scheduler.acquire(
      (priorityHandler) => {
        if (trace !== null) {
          trace.dispatched = performance.now()
        }
        try {
          dispatchResult = dispatch(opts, priorityHandler)
          if (dispatchResult != null) {
            // Promise.resolve assimilates thenables and converts a throwing
            // `.then` getter into a rejected Promise observed below.
            Promise.resolve(dispatchResult).catch((err) => {
              try {
                priorityHandler.onError(err)
              } catch {
                // The scheduler slot has already been released. A user
                // onError hook must not turn this observed rejection into a
                // second, unhandled rejection.
              }
            })
          }
        } catch (err) {
          priorityHandler.onError(err)
        }
      },
      opts.priority,
      priorityHandler,
    )

    // acquire() returns false only when no slot was free and the request was
    // queued — the breadcrumb for a request that enters the queue and never
    // leaves. pending is the post-enqueue queue depth, so it counts this
    // request.
    if (!acquired && trace !== null) {
      traceSafe(
        trace.write,
        {
          id: trace.id,
          key: trace.key,
          priority: trace.priority,
          phase: 'queued',
          pending: scheduler.pending,
          waitMs: null,
          holdMs: null,
        },
        'undici:priority',
      )
    }

    // acquire() invokes the callback synchronously when a slot is available,
    // so preserve the inner dispatch contract on that fast path. DispatchFn
    // explicitly permits void; queued work has no inner result yet, and a
    // synthetic Promise would introduce a second rejection channel alongside
    // handler.onError, so the queued path intentionally returns undefined.
    return dispatchResult
  }
}
