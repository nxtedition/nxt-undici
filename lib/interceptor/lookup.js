import { addAbortListener } from 'node:events'
import { errors } from '@nxtedition/undici'
import { DecoratorHandler } from '../utils.js'
import { traceWrite, traceSafe, traceErr, traceUrl } from '../trace.js'

const { RequestAbortedError } = errors

function noop() {}

function abortReason(signal) {
  return signal.reason === undefined ? new RequestAbortedError() : signal.reason
}

function listenForAbort(signal, listener) {
  if (typeof signal.addEventListener === 'function') {
    try {
      const disposable = addAbortListener(signal, listener)
      return () => disposable[Symbol.dispose]()
    } catch (err) {
      if (err?.code !== 'ERR_INVALID_ARG_TYPE') {
        throw err
      }

      // RequestSignal also permits generic EventTargets. They do not get
      // addAbortListener's propagation resistance, but retain the established
      // compatibility path used by request().
      signal.addEventListener('abort', listener)
      return () => signal.removeEventListener('abort', listener)
    }
  }

  signal.on('abort', listener)
  return () => signal.removeListener('abort', listener)
}

// Emit the single `undici:lookup` doc for an origin resolution: an async
// success carries the resolved origin, a failure carries the error tag. `url`
// is the requested origin+path; `resolved` is bounded like every other
// caller-influenced string.
function traceLookup(write, opts, start, resolved, err) {
  traceSafe(
    write,
    {
      id: opts.id ?? null,
      method: opts.method ?? null,
      url: traceUrl(opts),
      resolved,
      durationMs: Math.round(performance.now() - start),
      err,
    },
    'undici:lookup',
  )
}

export default () => (dispatch) => async (opts, handler) => {
  const lookup = opts.lookup

  if (!lookup) {
    return dispatch(opts, handler)
  }

  // Per-request, resolved after the passthrough return; used at most once
  // (one success OR failure doc per resolution).
  const write = traceWrite(opts.trace)
  const start = write !== null ? performance.now() : 0
  // A success doc is only worth emitting when the callback fired
  // asynchronously (service discovery): the default lookup calls back
  // synchronously and would produce a ~0ms doc per request.
  let resolvedAsync = false
  let dispatched = false

  // Wrap so the catch below can't deliver a second onError: if a downstream
  // layer already reported a terminal callback and then let an error escape
  // dispatch synchronously, DecoratorHandler's #errored/#completed guards
  // absorb the duplicate instead of violating the once-only onError contract.
  const wrapped = new DecoratorHandler(handler)

  try {
    const origin = await new Promise((resolve, reject) => {
      let sync = true
      let settled = false
      let removeAbortListener = noop

      const settle = (fn, value) => {
        if (settled) {
          return
        }

        settled = true
        removeAbortListener()
        removeAbortListener = noop
        fn(value)
      }

      const signal = opts.signal
      const onAbort = () => settle(reject, abortReason(signal))

      if (signal?.aborted) {
        onAbort()
        return
      }

      if (signal) {
        removeAbortListener = listenForAbort(signal, onAbort)
      }

      let thenable
      try {
        thenable = lookup(opts.origin, { signal: signal ?? undefined }, (err, val) => {
          if (!sync) {
            resolvedAsync = true
          }
          if (err) {
            settle(reject, err)
          } else {
            settle(resolve, val)
          }
        })
      } catch (err) {
        settle(reject, err)
        return
      } finally {
        sync = false
      }

      if (typeof thenable === 'string') {
        // Keep the established synchronous shorthand used by standalone
        // compositions, but do not treat arbitrary callback return values
        // (timer/request/cancellation handles) as resolved origins.
        settle(resolve, thenable)
        return
      }

      let then
      try {
        then = thenable?.then
      } catch (err) {
        settle(reject, err)
        return
      }

      if (typeof then === 'function') {
        // A promise-returning lookup is always asynchronous (`.then` callbacks
        // never run on the current stack), so its success doc must be emitted
        // like the async-callback shape's — only the sync callback path is
        // suppressed as noise.
        Promise.resolve(thenable).then(
          (val) => {
            // An async callback-style lookup may return a thenable that fulfills
            // with void before the callback fires, so only a string fulfillment
            // may take control of the lookup result.
            if (typeof val === 'string') {
              resolvedAsync = true
              settle(resolve, val)
            }
          },
          (err) => settle(reject, err),
        )
      }
    })

    if (!origin) {
      throw new Error('invalid origin: ' + origin)
    }

    if (write !== null && resolvedAsync) {
      traceLookup(write, opts, start, String(origin).slice(0, 256), null)
    }

    dispatched = true
    // DispatchFn explicitly permits a Promise return. Await it inside this
    // try/catch so an asynchronous downstream failure follows the same
    // handler.onError path as a synchronous throw; request() intentionally
    // ignores the dispatch return value and would otherwise hang while the
    // rejection becomes unhandled.
    return await dispatch({ ...opts, origin }, wrapped)
  } catch (err) {
    // The try also covers the inner dispatch call — a sync throw escaping the
    // inner chain is not a lookup failure and must not be attributed to one.
    if (write !== null && !dispatched) {
      traceLookup(write, opts, start, null, traceErr(err))
    }
    wrapped.onError(err)
  }
}
