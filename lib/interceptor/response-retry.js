import assert from 'node:assert'
import tp from 'node:timers/promises'
import {
  DecoratorHandler,
  isDisturbed,
  decorateError,
  parseContentRange,
  parseHeaders,
} from '../utils.js'
import { RequestAbortedError } from '../errors.js'

// Maximum number of >= 400 response body bytes buffered for replay in case
// the response is not retried. Larger bodies are passed straight through and
// the response is not status-code retried.
const MAX_ERROR_BODY_SIZE = 256 * 1024

function noop() {}

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

      // A duplicated etag response header arrives as an array, which has no
      // startsWith and cannot be used for resumption — treat it as absent.
      // Weak etags are not useful for comparison nor cache
      // for instance not safe to assume if the response is byte-per-byte
      // equal
      if (this.#etag != null && (typeof this.#etag !== 'string' || this.#etag.startsWith('W/'))) {
        this.#etag = null
      }

      assert(Number.isFinite(this.#pos))
      assert(this.#end == null || Number.isFinite(this.#end))

      this.#resume = resume

      this.#headersSent = true
      return super.onHeaders(statusCode, headers, () => this.#resume?.())
    } else if (statusCode === 206 || (this.#pos === 0 && statusCode === 200)) {
      assert(this.#etag != null || !this.#pos)

      if (this.#pos > 0 && this.#etag !== headers.etag) {
        this.#maybeError(null)
        return false
      }

      if (this.#pos === 0 && statusCode === 200) {
        // We asked for a byte range to resume, but no bytes had been forwarded
        // to the consumer yet, so a server that ignored Range and replied with
        // the full 200 is acceptable — forward it from the start. (RFC 9110
        // permits ignoring Range; if-match still guards against changed
        // content via a 412.) Without this, a legal full 200 retry was
        // rejected with "Response retry failed".
        //
        // The server restarted the response from scratch, so the previous
        // attempt's resume metadata no longer describes what we're receiving:
        // refresh #end/#etag from THIS response's headers, otherwise a second
        // failure would resume against the stale content-length/etag.
        const contentLength = headers['content-length'] ? Number(headers['content-length']) : null
        this.#end = Number.isFinite(contentLength) ? contentLength : null
        // Same guard as the first-response path: only strong (non-weak),
        // scalar etags are safe to use for resume validation.
        this.#etag =
          typeof headers.etag === 'string' && !headers.etag.startsWith('W/') ? headers.etag : null
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
      // happened. Report the current status and keep the prior failure as
      // the cause.
      const err = new Error(
        `Response retry failed with status code ${statusCode}`,
        this.#retryError != null ? { cause: this.#retryError } : undefined,
      )
      err.statusCode = statusCode
      this.#maybeError(err)
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
    if (!err && this.#aborted) {
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

    if (err) {
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
      // Once headers have been forwarded, a range resume is the only option —
      // but it is impossible when the response wasn't tracked for resumption
      // (#pos == null, e.g. a passed-through >= 400 body, a trailer response,
      // or other passthrough statuses) or the body was zero-length (#end === 0,
      // nothing left to request — `bytes=0--1` is invalid). Without this, the
      // resume asserts below would throw and be delivered to the user IN PLACE
      // of the original error.
      (this.#headersSent && (this.#pos == null || this.#end === 0)) ||
      (this.#pos && !this.#etag)
    ) {
      this.#maybeError(err)
      return
    }

    let retryPromise
    try {
      if (typeof this.#opts.retry === 'function') {
        retryPromise = Promise.resolve(
          this.#opts.retry(
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
        } else if (!shouldRetry || isDisturbed(this.#opts.body)) {
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
          this.#opts.headers['if-match'] = this.#etag
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
        // abort reason instead (falsy reasons are normalized in #maybeError).
        this.#maybeError(this.#aborted ? this.#reason : err)
      })
  }

  // Backoff wait that is abortable by the handler-chain abort (via the
  // internal AbortController the onConnect wrapper aborts), not just by
  // opts.signal — otherwise a downstream abort during the wait leaves a ref'd
  // timer holding the event loop for up to 60s. opts.signal is chained only
  // when it is a real AbortSignal; the library also accepts EventEmitter-style
  // signals elsewhere and tp.setTimeout would throw on those.
  #backoff(delay, opts) {
    this.#retryAbortController ??= new AbortController()
    const signal =
      opts?.signal instanceof AbortSignal
        ? AbortSignal.any([this.#retryAbortController.signal, opts.signal])
        : this.#retryAbortController.signal
    return tp.setTimeout(delay, true, { signal })
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

    const statusCode =
      err?.statusCode ?? err?.status ?? err?.$metadata?.httpStatusCode ?? this.#statusCode
    const headers = err?.headers ?? this.#headers

    if (statusCode && [420, 429, 502, 503, 504].includes(statusCode)) {
      const raw = headers?.['retry-after']
      let retryAfter = raw ? Number(raw) * 1e3 : null
      if (raw && (retryAfter == null || !Number.isFinite(retryAfter))) {
        // RFC 9110: Retry-After may be an HTTP-date rather than delta-seconds.
        const date = Date.parse(raw)
        retryAfter = Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
      }
      const delay =
        retryAfter != null && Number.isFinite(retryAfter)
          ? // Clamp the server-controlled wait: bounds a hostile/misconfigured
            // value and avoids the 32-bit timer overflow that makes huge delays
            // fire immediately.
            Math.min(retryAfter, 60e3)
          : Math.min(10e3, retryCount * 1e3)
      this.#opts.logger?.debug({ statusCode, retryAfter, delay, retryCount }, 'retry delay')
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
      this.#opts.logger?.debug({ err, retryCount }, 'retry delay')
      return this.#backoff(Math.min(10e3, retryCount * 1e3), opts)
    }

    if (err?.message && ['other side closed'].includes(err.message)) {
      this.#opts.logger?.debug({ err, retryCount }, 'retry delay')
      return this.#backoff(Math.min(10e3, retryCount * 1e3), opts)
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
