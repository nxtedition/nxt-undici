// Delivery of a stored (or synthetic) entry straight to the user handler,
// plus the `undici:cache` lookup-doc emitter shared with the read path.
import { isStream } from '../../utils.js'
import { traceSafe } from '../../trace.js'

/**
 * The single `undici:cache` lookup-doc emitter (read path). `write` is the
 * resolved trace fn (null when tracing is off), captured once per dispatch so
 * a writer flipping mid-request can't split a dispatch across writers.
 */
export function traceLookup(
  write,
  opts,
  url,
  result,
  reason,
  statusCode,
  ageSec,
  sizeBytes,
  lookupMs,
) {
  traceSafe(
    write,
    {
      id: opts.id ?? null,
      method: opts.method ?? null,
      url,
      result,
      reason,
      statusCode,
      ageSec,
      sizeBytes,
      lookupMs,
    },
    'undici:cache',
  )
}

export function serveFromCache(
  entry,
  opts,
  handler,
  write = null,
  url = null,
  lookupMs = null,
  result = 'hit',
  reason = null,
) {
  const { statusCode, trailers, body } = entry

  let headers = entry.headers
  let age = null
  if (entry.cachedAt != null) {
    // RFC 9111 §5.1: every response served from cache must carry an Age
    // header. cachedAt is backdated by the corrected initial age at store
    // time (§4.2.3) and the origin's Age header is stripped, so resident time
    // IS the response's age — no origin-Age addition. Date.now(), not
    // getFastNow(): the lagging clock would understate a relayed response's
    // initial age by up to a second.
    age = Math.max(0, Math.floor((Date.now() - entry.cachedAt) / 1000))
    headers = { ...headers, age: `${age}` }
  }

  // Entry serves and conditional 304s are lookup hits; the only-if-cached
  // synthetic 504 arrives as result 'miss' from the caller. Synthetic entries
  // have no cachedAt, so their ageSec stays null. Emitted before onConnect.
  if (write !== null) {
    traceLookup(write, opts, url, result, reason, statusCode, age, body?.byteLength ?? 0, lookupMs)
  }

  // serveFromCache drives the raw user handler directly (no DecoratorHandler),
  // so it must enforce the contract itself: onError is terminal and mutually
  // exclusive with onComplete. The `completed` guard makes a late abort() a
  // no-op, and onComplete runs outside the try so a throw from the user's
  // terminal callback propagates instead of being converted into a second
  // (post-complete) onError.
  let aborted = false
  let completed = false
  const abort = (reason) => {
    if (!aborted && !completed) {
      aborted = true
      handler.onError(reason)
    }
  }

  // Dump the request body so its underlying resources are released. Only a
  // stream needs draining; a Buffer/string body has no .on()/.resume(), and
  // calling them would throw a TypeError that aborts an otherwise-valid cache
  // hit (a cached GET/HEAD issued with a non-stream body).
  if (isStream(opts.body)) {
    opts.body.on('error', () => {}).resume()
  }

  // Backpressure: onData returning false is the strict "pause until resume()"
  // contract, and it is the only one worth honoring here — a cache serve
  // delivers the whole body in a single onData, so the only callback that can
  // follow a pause is onComplete. (Pausing at onHeaders is a weak, rarely
  // used contract; the return value of onHeaders is ignored.) The handler may
  // also call resume() SYNCHRONOUSLY from within onData before returning
  // false ("never mind, keep going"); at that point `completePending` isn't
  // set yet, so record it in `resumed` and skip parking, otherwise the resume
  // is dropped and onComplete never fires.
  let completePending = false
  let resumed = false
  const resume = () => {
    if (completePending) {
      completePending = false
      deliverComplete()
    } else {
      resumed = true
    }
  }

  function deliverComplete() {
    if (aborted || completed) {
      return
    }
    completed = true
    // Outside any try: a throw from the user's terminal callback must
    // propagate instead of being converted into a post-complete onError.
    handler.onComplete(trailers ?? {})
  }

  try {
    handler.onConnect(abort)
    if (aborted) {
      return
    }

    handler.onHeaders(statusCode, headers ?? {}, resume)
    if (aborted) {
      return
    }

    if (body?.byteLength) {
      const flowing = handler.onData(body)
      if (aborted) {
        return
      }
      if (flowing === false && !resumed) {
        // Paused: deliver onComplete when the handler resumes.
        completePending = true
        return
      }
    }
  } catch (err) {
    abort(err)
    return
  }

  deliverComplete()
}
