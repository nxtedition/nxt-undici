import assert from 'node:assert'
import tp from 'node:timers/promises'
import {
  DecoratorHandler,
  isDisturbed,
  decorateError,
  invalidateNormalizedHeaders,
  parseContentRange,
  parseHeaders,
  parseHttpDate,
} from '../utils.js'
import { RequestAbortedError } from '../errors.js'
import { traceWrite, traceSafe, traceErr, traceUrl } from '../trace.js'

// Maximum number of >= 400 response body bytes buffered for replay in case
// the response is not retried. Larger bodies are passed straight through and
// the response is not status-code retried.
const MAX_ERROR_BODY_SIZE = 256 * 1024

function noop() {}

function isOneShotIterable(body) {
  if (body == null || typeof body !== 'object') {
    return false
  }

  try {
    const iteratorFactory = body[Symbol.iterator]
    if (typeof iteratorFactory === 'function') {
      const iterator = iteratorFactory.call(body)
      if (iteratorFactory.call(body) === iterator) {
        return true
      }
    }

    const asyncIteratorFactory = body[Symbol.asyncIterator]
    if (typeof asyncIteratorFactory === 'function') {
      const iterator = asyncIteratorFactory.call(body)
      if (asyncIteratorFactory.call(body) === iterator) {
        return true
      }
    }

    return false
  } catch {
    // If asking for another iterator already fails, the body cannot be replayed.
    return true
  }
}

// RFC 9110 §8.8.3: a strong entity-tag is a quoted opaque-tag without the
// case-sensitive W/ prefix. Validate the complete grammar before putting a
// server-provided value into If-Match; merely rejecting strings that start
// with W/ would misclassify malformed values such as `bogus`, `w/"tag"`
// or quoted strings containing spaces/control characters as strong validators.
function isStrongEtag(value) {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.charCodeAt(0) !== 0x22 ||
    value.charCodeAt(value.length - 1) !== 0x22
  ) {
    return false
  }

  // etagc = %x21 / %x23-7E / obs-text (%x80-FF). DQUOTE (%x22),
  // whitespace, controls and Unicode outside the HTTP byte range are invalid.
  for (let i = 1; i < value.length - 1; i++) {
    const code = value.charCodeAt(i)
    if (code !== 0x21 && !(code >= 0x23 && code <= 0x7e) && !(code >= 0x80 && code <= 0xff)) {
      return false
    }
  }
  return true
}

// Emit an `undici:retry` trace doc at the point a retry is actually scheduled.
// Cold path only — a retry already implies a failed attempt — so resolving the
// writer per emission (same resolution as the trace interceptor: explicit
// opts.trace wins, absent falls back to the global) costs nothing on the
// request hot path. `cause` is the triggering failure: the attempt's error, or
// the bare status code for a status-code retry without one.
function traceRetry(opts, retryCount, delay, cause) {
  const write = traceWrite(opts.trace)
  if (write !== null) {
    traceSafe(
      write,
      {
        id: opts.id ?? null,
        method: opts.method ?? null,
        url: traceUrl(opts),
        retryCount,
        delayMs: delay,
        err: traceErr(cause),
      },
      'undici:retry',
    )
  }
}

// Subscribe `onAbort` to an EventEmitter-style OR EventTarget-style signal and
// return an unsubscribe function; return null when it cannot be done safely.
//
// The caller (both sleep() and #backoff) must be able to unsubscribe once the
// wait settles, so we require a MATCHING subscribe/unsubscribe PAIR up front:
// subscribing with `on` but no `removeListener`/`off`, or `addEventListener`
// but no `removeEventListener`, would crash later when we try to remove the
// listener. request() validates signals up front (lib/request.js throws
// InvalidArgumentError for anything without .on/.addEventListener), so garbage
// only reaches here through a raw compose()/dispatch() caller — for that case
// return null so the caller degrades to a plain timer instead of crashing.
// A throwing subscribe is treated the same way.
function subscribeAbort(signal, onAbort) {
  const isEventTarget =
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
  const removeEmitterListener =
    typeof signal.removeListener === 'function' ? signal.removeListener : signal.off
  const isEmitter = typeof signal.on === 'function' && typeof removeEmitterListener === 'function'

  if (!isEventTarget && !isEmitter) {
    return null
  }

  try {
    if (isEventTarget) {
      signal.addEventListener('abort', onAbort)
      return () => signal.removeEventListener('abort', onAbort)
    }
    signal.on('abort', onAbort)
    return () => removeEmitterListener.call(signal, 'abort', onAbort)
  } catch {
    // A throwing subscribe leaves nothing to unsubscribe.
    return null
  }
}

// timers/promises.setTimeout only accepts a real AbortSignal and throws
// ERR_INVALID_ARG_TYPE for anything else — but the library also accepts
// EventEmitter-style abort signals (see RequestHandler in lib/request.js).
// For those, race the backoff timer against the 'abort' event instead of
// passing the signal through. When no complete subscribe/unsubscribe pair is
// available (a raw dispatch() caller passing a bare object), fall back to a
// plain timer rather than crash.
function sleep(delay, signal) {
  if (signal == null || signal instanceof AbortSignal) {
    return tp.setTimeout(delay, true, { signal: signal ?? undefined })
  }

  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new RequestAbortedError())
  }

  return new Promise((resolve, reject) => {
    let removeAbortListener = noop

    const timer = setTimeout(() => {
      removeAbortListener()
      resolve(true)
    }, delay)

    const onAbort = () => {
      clearTimeout(timer)
      removeAbortListener()
      reject(signal.reason ?? new RequestAbortedError())
    }

    // Decide the branch up front by verifying a matching add/remove pair;
    // without one there is nothing to safely race against, so the already
    // running plain timer completes the sleep. A throwing subscribe leaves
    // removeAbortListener as noop, and the timer still resolves.
    removeAbortListener = subscribeAbort(signal, onAbort) ?? noop
  })
}

// Exponential backoff with equal jitter. The first retry is immediate — a
// failure on a reused socket (ECONNRESET/EPIPE on a stale keep-alive
// connection) almost always succeeds on a fresh connection, and callers rely
// on that being invisible. From there 1s·2^(n−1) capped at maxDelay, of which
// a random 50–100% is used so a fleet that failed against the same upstream
// at the same moment does not retry in lockstep against it while it recovers.
// Exported for tests.
export function backoffDelay(retryCount, maxDelay) {
  if (retryCount <= 0) {
    return 0
  }
  // Also clamp to the platform timer max: setTimeout overflows 32 bits and
  // fires immediately for larger delays (same guard as the retry-after clamp),
  // so a huge user-provided maxDelay must not produce instant retries.
  const delay = Math.min(2 ** (retryCount - 1) * 1e3, maxDelay, 2 ** 31 - 1)
  return delay / 2 + Math.random() * (delay / 2)
}

class Handler extends DecoratorHandler {
  #dispatch
  #opts

  #retryCount = 0
  #retryError = null
  #headersSent = false
  #errorSent = false

  #statusCode = 0
  #headers
  #trailers
  #body
  #bodySize = 0

  #abort
  #aborted = false
  #reason
  #resume
  #retryAbortController = null

  #pos
  #end
  #etag

  constructor(opts, { handler, dispatch }) {
    super(handler)

    this.#dispatch = dispatch

    if (typeof opts === 'number') {
      this.#opts = { count: opts }
    } else if (typeof opts === 'boolean') {
      this.#opts = null
    } else if (typeof opts === 'object') {
      this.#opts = opts
    } else {
      throw new Error('invalid argument: opts')
    }
  }

  onConnect(abort) {
    this.#statusCode = 0
    this.#headers = null
    this.#body = null
    this.#bodySize = 0
    this.#trailers = null

    if (!this.#headersSent) {
      this.#pos = null
      this.#end = null
      this.#etag = null
      this.#resume = null

      super.onConnect((reason) => {
        if (!this.#aborted) {
          this.#aborted = true
          // Always remember the reason: a downstream abort can land during the
          // backoff wait between attempts, when #abort still points at the
          // finished attempt's abort which undici has made a no-op. Without
          // the recorded reason there is nothing to deliver once the retry
          // machinery observes #aborted. Mirrors redirect.js.
          this.#reason = reason
          this.#abort?.(reason)
          // Wake a pending backoff wait so the terminal onError is delivered
          // promptly and the ref'd retry timer (up to 60s for retry-after)
          // does not hold the event loop.
          this.#retryAbortController?.abort(reason)
        }
      })
    }

    if (this.#aborted) {
      abort(this.#reason)
    } else {
      this.#abort = abort
    }
  }

  onUpgrade() {
    // TODO (fix): Should we support this?
    throw new Error('not supported')
  }

  onHeaders(statusCode, headers, resume) {
    this.#statusCode = statusCode
    this.#headers = headers

    if (statusCode < 200) {
      return super.onHeaders(statusCode, headers, resume)
    }

    if (!this.#headersSent) {
      assert(this.#etag == null)
      assert(this.#pos == null)
      assert(this.#end == null)
      assert(this.#headersSent === false)

      if (headers.trailer) {
        this.#headersSent = true
        return super.onHeaders(statusCode, headers, resume)
      }

      const contentLength = headers['content-length'] ? Number(headers['content-length']) : null
      if (contentLength != null && !Number.isFinite(contentLength)) {
        this.#headersSent = true
        return super.onHeaders(statusCode, headers, resume)
      }

      if (statusCode === 206) {
        const { start, size, end = size } = parseContentRange(headers['content-range']) ?? {}
        if (start == null || end == null || contentLength !== end - start) {
          this.#headersSent = true
          return super.onHeaders(statusCode, headers, resume)
        }

        this.#pos = start
        this.#end = end ?? contentLength
        this.#etag = headers.etag
      } else if (statusCode === 200) {
        this.#pos = 0
        this.#end = contentLength
        this.#etag = headers.etag
      } else if (statusCode >= 400) {
        if (
          contentLength != null &&
          contentLength > MAX_ERROR_BODY_SIZE &&
          this.#opts.method !== 'HEAD'
        ) {
          // The error body is too large to buffer for a replay if the retry
          // is declined. Pass it straight through instead of buffering —
          // such a response is simply not status-code retried.
          this.#headersSent = true
          return super.onHeaders(statusCode, headers, resume)
        }

        this.#body = []
        this.#bodySize = 0
        this.#resume = resume
        return true
      } else {
        this.#headersSent = true
        return super.onHeaders(statusCode, headers, resume)
      }

      // Only a syntactically valid strong entity-tag can prove that a resumed
      // body belongs to the representation whose headers were already sent.
      // Duplicated, weak and malformed values are treated as absent and never
      // copied into If-Match.
      if (!isStrongEtag(this.#etag)) {
        this.#etag = null
      }

      assert(Number.isFinite(this.#pos))
      assert(this.#end == null || Number.isFinite(this.#end))

      this.#resume = resume

      this.#headersSent = true
      return super.onHeaders(statusCode, headers, () => this.#resume?.())
    } else if (statusCode === 206 || (this.#pos === 0 && statusCode === 200)) {
      assert(this.#etag != null || !this.#pos)

      // A resume — a 206 range, or a full 200 from a server that ignored the
      // resume Range at pos 0 — is spliced onto the headers ALREADY forwarded
      // from the first attempt (and, behind a cache, already used to build the
      // stored entry: its status, cache-control/TTL, Date and validators). That
      // splice is only sound when this response is the SAME representation as
      // the first. A compliant origin answers a changed representation to the
      // resume's if-match with 412 — but HTTP does not oblige a 2xx to carry an
      // etag at all, even when if-match was evaluated. So rather than trust the
      // origin, impose a stricter CLIENT-SIDE acceptance rule: only splice when
      // this response echoes the same strong etag the resume validated against;
      // a 2xx that changed or dropped the etag is declined. At pos 0 without a
      // strong etag we sent no validator (the `this.#pos && !this.#etag` resume
      // guard is falsy at pos 0), so a full 200 could be a different or updated
      // representation — accepting it would let a cache persist attempt 1's
      // headers, cache-control/TTL and validators paired with attempt 2's body
      // and replay that splice for the first response's freshness lifetime,
      // ignoring attempt 2's own (possibly shorter or no-store) caching. Decline
      // via the graceful #maybeError path with a descriptive reason (an assert
      // here would throw out of this parser callback and hang the stream). At
      // pos > 0 the resume guard already guarantees a strong #etag, so this only
      // tightens pos 0.
      if (typeof this.#etag !== 'string' || this.#etag !== headers.etag) {
        this.#maybeError(
          new Error(
            'Response retry failed: resumed response did not echo the strong etag required to splice it onto the already-forwarded headers',
          ),
        )
        return false
      }

      if (this.#pos === 0 && statusCode === 200) {
        // The server restarted the response from scratch, so the first
        // attempt's content-length no longer describes what we're receiving:
        // refresh #end from THIS response so a second failure resumes against
        // the right length. #etag is unchanged — we just confirmed it equals
        // this response's (strong) etag.
        const contentLength = headers['content-length'] ? Number(headers['content-length']) : null
        this.#end = Number.isFinite(contentLength) ? contentLength : null
        this.#resume = resume
        return true
      }

      const contentRange = parseContentRange(headers['content-range'])
      if (!contentRange) {
        this.#maybeError(null)
        return false
      }

      // Validate the server's content-range against our tracked position.
      // These values are server-controlled, so route a mismatch through the
      // same graceful error path as the branches above — an assert() here
      // would throw out of onHeaders (a parser callback) and hang the stream.
      const { start, size, end = size } = contentRange
      if (this.#pos !== start || (this.#end != null && this.#end !== end)) {
        this.#maybeError(null)
        return false
      }

      this.#resume = resume

      // TODO (fix): What if we were paused before the error?
      return true
    } else {
      // A resume attempt landed on an unexpected status (e.g. a 503 while
      // resuming). #retryError describes the PREVIOUS failure — surfacing it
      // as-is would report a stale error that says nothing about what just
      // happened. Report the current response metadata and keep the prior
      // failure as the cause.
      const err = new Error(
        `Response retry failed with status code ${statusCode}`,
        this.#retryError != null ? { cause: this.#retryError } : undefined,
      )
      this.#maybeError(
        decorateError(err, this.#opts, {
          statusCode,
          headers,
          trailers: this.#trailers,
          body: null,
        }),
      )
      return false
    }
  }

  onData(chunk) {
    if (this.#pos != null) {
      this.#pos += chunk.byteLength
    }

    if (this.#statusCode < 400 || (this.#headersSent && !this.#errorSent)) {
      return super.onData(chunk)
    }

    if (this.#body) {
      this.#body.push(chunk)
      this.#bodySize += chunk.byteLength
      if (this.#bodySize > MAX_ERROR_BODY_SIZE) {
        // The error body has grown too large to buffer for a replay if the
        // retry is declined. Flush the buffered chunks downstream and fall
        // back to passing the response through — it is no longer
        // status-code retried. Previously the buffer was discarded here,
        // which made #maybeError replay headers followed by zero body bytes.
        const body = this.#body
        this.#body = null
        this.#bodySize = 0

        this.#headersSent = true
        let ret = super.onHeaders(this.#statusCode, this.#headers, () => this.#resume?.())
        for (const buffered of body) {
          if (this.#aborted) {
            return false
          }
          ret = super.onData(buffered)
        }
        return ret
      }
    }
  }

  onComplete(trailers) {
    this.#trailers = trailers

    if (this.#statusCode < 400) {
      return super.onComplete(trailers)
    }

    if (this.#headersSent && !this.#errorSent) {
      // The >= 400 response was passed through (too large to buffer for
      // replay) — headers and data have already been forwarded downstream.
      return super.onComplete(trailers)
    }

    this.#maybeRetry(null)
  }

  onError(err) {
    this.#maybeRetry(err)
  }

  #maybeAbort(err) {
    if (this.#abort && !this.#aborted) {
      this.#aborted = true
      this.#abort(err)
    }
  }

  #maybeError(err) {
    if (err == null && this.#aborted) {
      // Downstream aborted (e.g. during the backoff wait between attempts).
      // The replay branches below are suppressed by the aborted
      // DecoratorHandler, so without this no terminal event would ever reach
      // downstream (raw dispatch would hang forever), or a generic
      // 'Response retry failed' would replace the abort reason.
      // DecoratorHandler.onError still forwards after an abort, so deliver
      // the abort reason as the terminal onError (exactly once, guarded by
      // #errorSent below).
      err = this.#reason ?? new RequestAbortedError()
    }

    if (err != null) {
      if (!this.#errorSent) {
        this.#errorSent = true
        super.onError(err)
      }
    } else if (!this.#headersSent) {
      super.onHeaders(this.#statusCode, this.#headers, noop)
      if (this.#aborted) {
        return
      }

      if (this.#body) {
        for (const chunk of this.#body) {
          super.onData(chunk)
          if (this.#aborted) {
            return
          }
        }
      }

      super.onComplete(this.#trailers)
    } else {
      // Headers already sent but retry failed (e.g. etag mismatch, missing
      // content-range). The user is waiting for data/complete — send an error
      // so the response stream doesn't hang.
      if (!this.#errorSent) {
        this.#errorSent = true
        super.onError(new Error('Response retry failed'))
      }
    }

    this.#maybeAbort(err)
  }

  #maybeRetry(err) {
    if (
      this.#aborted ||
      isDisturbed(this.#opts.body) ||
      isOneShotIterable(this.#opts.body) ||
      // Once headers have been forwarded, a range resume is the only option —
      // but it is impossible when the response wasn't tracked for resumption
      // (#pos == null, e.g. a trailer response or a passed-through >= 400
      // body) or #end is not positive: zero means nothing left to request
      // (`bytes=0--1` is invalid), negative means the server sent a bogus
      // content-length (e.g. `-5`). A non-positive #end can enter both from
      // the initial response and from a full-200 restart, so guard here at
      // the single resume decision point, mirroring the precondition asserted
      // below. Without this, the resume asserts would throw and be delivered
      // to the user IN PLACE of the original error.
      (this.#headersSent && (this.#pos == null || (this.#end != null && this.#end <= 0))) ||
      (this.#pos && !this.#etag)
    ) {
      this.#maybeError(err)
      return
    }

    let retryPromise
    try {
      const retryOpts = this.#opts.retry
      const isObjectRetry = retryOpts !== null && typeof retryOpts === 'object'
      const retry = typeof retryOpts === 'function' ? retryOpts : isObjectRetry && retryOpts.retry

      // Object-form retry options can combine a strategy with a hard attempt
      // cap. Apply the cap before invoking the strategy; otherwise
      // `{ count: 2, retry: () => true }` retries forever and the `count`
      // option is silently ignored. A bare retry function retains its
      // existing strategy-owned count semantics.
      if (
        typeof retry === 'function' &&
        isObjectRetry &&
        this.#retryCount >= (retryOpts.count ?? 8)
      ) {
        retryPromise = Promise.resolve(false)
      } else if (typeof retry === 'function') {
        // The strategy receives both opts and err.req.headers. Treat it as a
        // mutable user boundary so the next parseHeaders() call validates any
        // changes instead of taking the identity fast path.
        invalidateNormalizedHeaders(this.#opts.headers)
        retryPromise = Promise.resolve(
          retry(
            decorateError(err, this.#opts, {
              statusCode: this.#statusCode || undefined,
              headers: this.#headers,
              trailers: this.#trailers,
              body: this.#body,
            }),
            this.#retryCount,
            this.#opts,
            () => this.#retryFn(err, this.#retryCount, this.#opts),
          ),
        )
      } else {
        retryPromise = Promise.resolve(this.#retryFn(err, this.#retryCount, this.#opts))
      }
    } catch (err) {
      retryPromise = Promise.reject(err)
    }

    retryPromise
      .then((shouldRetry) => {
        if (this.#aborted) {
          this.#maybeError(this.#reason)
        } else if (
          !shouldRetry ||
          isDisturbed(this.#opts.body) ||
          isOneShotIterable(this.#opts.body)
        ) {
          this.#maybeError(err)
        } else if (!this.#headersSent) {
          this.#opts.logger?.debug({ err, retryCount: this.#retryCount }, 'retry response headers')

          this.#retryCount++
          this.#retryError = err

          return this.#dispatch(this.#opts, this)
        } else {
          assert(Number.isFinite(this.#pos))
          assert(this.#end == null || (Number.isFinite(this.#end) && this.#end > 0))

          // Direct dispatch()/compose() callers may pass undici's legal flat
          // [name, value, ...] array headers; spreading that form would send
          // garbage numeric header names ('0', '1', ...) on the wire instead
          // of the real ones. Normalize to an object first (same as
          // redirect.js does).
          this.#opts = {
            ...this.#opts,
            headers: Array.isArray(this.#opts.headers)
              ? parseHeaders(this.#opts.headers)
              : { ...this.#opts.headers },
          }
          // A pos 0 resume is allowed without an etag (nothing was forwarded
          // yet, so nothing can tear) — but then there is no etag to validate
          // against. Only send if-match when we actually hold one; a null
          // value would go on the wire as an invalid empty `if-match:` header.
          // Delete any if-match a PREVIOUS resume attempt wrote first: the
          // spread above copies it from the reassigned opts, and #etag may
          // have been cleared since (e.g. a full-200 restart with a weak or
          // missing etag) — the stale validator must not go on the wire.
          delete this.#opts.headers['if-match']
          if (typeof this.#etag === 'string') {
            this.#opts.headers['if-match'] = this.#etag
          }
          this.#opts.headers.range = `bytes=${this.#pos}-${this.#end ? this.#end - 1 : ''}`
          this.#opts.logger?.debug({ err, retryCount: this.#retryCount }, 'retry response body')

          this.#retryCount++
          this.#retryError = err

          return this.#dispatch(this.#opts, this)
        }
      })
      .catch((err) => {
        // When the downstream abort cancelled the backoff timer, the timer's
        // own AbortError rejection is just plumbing — deliver the recorded
        // abort reason instead (including a caller-provided falsy reason).
        this.#maybeError(this.#aborted ? this.#reason : err)
      })
  }

  // Backoff wait that is abortable by the handler-chain abort (via the
  // internal AbortController the onConnect wrapper aborts) AND by opts.signal —
  // otherwise a downstream abort during the wait leaves a ref'd timer holding
  // the event loop for up to 60s (retry-after).
  //
  // The internal controller's signal is always a real AbortSignal, so it is
  // the single thing the wait races against:
  //   - a real AbortSignal opts.signal is composed with AbortSignal.any (the
  //     idiomatic path; a real AbortSignal already carries the add/remove pair
  //     subscribeAbort would look for, so .any subsumes it), and
  //   - an EventEmitter-style opts.signal (the library also accepts those, see
  //     RequestHandler in lib/request.js) — which AbortSignal.any cannot take —
  //     is bridged into the internal controller via the same crash-safe
  //     subscribeAbort used by sleep(): its 'abort' aborts the controller with
  //     the signal's reason. A signal with no complete subscribe/unsubscribe
  //     pair (raw dispatch() garbage) yields no bridge and the wait is still
  //     cancellable by the internal controller, so the retry proceeds.
  // sleep() then takes its tp.setTimeout fast path on the resulting real
  // AbortSignal.
  #backoff(delay, opts) {
    this.#retryAbortController ??= new AbortController()
    const controller = this.#retryAbortController
    const signal = opts?.signal

    if (signal == null) {
      return sleep(delay, controller.signal)
    }

    if (signal instanceof AbortSignal) {
      return sleep(delay, AbortSignal.any([controller.signal, signal]))
    }

    if (signal.aborted) {
      controller.abort(signal.reason ?? new RequestAbortedError())
      return sleep(delay, controller.signal)
    }

    const removeAbortListener =
      subscribeAbort(signal, () => controller.abort(signal.reason ?? new RequestAbortedError())) ??
      noop
    const wait = sleep(delay, controller.signal)
    // Detach the bridge once the wait settles so an EE signal that outlives the
    // backoff (e.g. aborted after a successful retry) is not still referenced.
    return wait.finally(removeAbortListener)
  }

  async #retryFn(err, retryCount, opts) {
    if (this.#aborted) {
      // A user retry callback may invoke this after downstream has already
      // aborted — don't start a backoff timer that nothing will cancel.
      // #maybeRetry's promise chain observes #aborted and delivers #reason.
      return false
    }

    let retryOpts = opts?.retry

    if (!retryOpts) {
      return false
    }

    if (typeof retryOpts === 'number') {
      retryOpts = { count: retryOpts }
    }

    const retryMax = retryOpts?.count ?? 8

    if (retryCount >= retryMax) {
      return false
    }

    // Default cap 60s — the exponential curve then spans the full default
    // 8-retry budget (0, 1, 2, 4, 8, 16, 32, 60s ≈ 2min total), enough to ride
    // out a container reschedule or rolling redeploy of an upstream. Matches
    // the retry-after clamp below.
    const maxDelay =
      Number.isFinite(retryOpts?.maxDelay) && retryOpts.maxDelay >= 0 ? retryOpts.maxDelay : 60e3

    const statusCode =
      err?.statusCode ?? err?.status ?? err?.$metadata?.httpStatusCode ?? this.#statusCode
    const headers = err?.headers ?? this.#headers

    if (statusCode && [420, 429, 502, 503, 504].includes(statusCode)) {
      const raw = headers?.['retry-after']
      let retryAfter = raw ? Number(raw) * 1e3 : null
      if (raw && (retryAfter == null || !Number.isFinite(retryAfter))) {
        // RFC 9110: Retry-After may be an HTTP-date rather than delta-seconds.
        const date = parseHttpDate(raw)?.getTime()
        retryAfter = date != null ? Math.max(0, date - Date.now()) : null
      }
      const delay =
        retryAfter != null && Number.isFinite(retryAfter)
          ? // Clamp the server-controlled wait: bounds a hostile/misconfigured
            // value and avoids the 32-bit timer overflow that makes huge delays
            // fire immediately.
            Math.min(retryAfter, 60e3)
          : backoffDelay(retryCount, maxDelay)
      this.#opts.logger?.debug({ statusCode, retryAfter, delay, retryCount }, 'retry delay')
      traceRetry(this.#opts, retryCount, delay, err ?? statusCode)
      return this.#backoff(delay, opts)
    }

    if (
      err?.code &&
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'ENETDOWN',
        'ENETUNREACH',
        'EHOSTDOWN',
        'EHOSTUNREACH',
        'EPIPE',
        'EAI_AGAIN',
        'ENODATA',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(err.code)
    ) {
      const delay = backoffDelay(retryCount, maxDelay)
      this.#opts.logger?.debug({ err, retryCount }, 'retry delay')
      traceRetry(this.#opts, retryCount, delay, err)
      return this.#backoff(delay, opts)
    }

    if (err?.message && ['other side closed'].includes(err.message)) {
      const delay = backoffDelay(retryCount, maxDelay)
      this.#opts.logger?.debug({ err, retryCount }, 'retry delay')
      traceRetry(this.#opts, retryCount, delay, err)
      return this.#backoff(delay, opts)
    }

    return false
  }
}

export default () => (dispatch) => (opts, handler) =>
  opts.retry !== false &&
  !opts.upgrade &&
  (/^(HEAD|GET|PUT|PATCH|QUERY)$/.test(opts.method) || opts.idempotent) &&
  opts.idempotent !== false
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)
