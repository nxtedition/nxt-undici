import assert from 'node:assert'
import tp from 'node:timers/promises'
import { DecoratorHandler, isDisturbed, parseRangeHeader } from '../utils.js'
import createHttpError from 'http-errors'

function noop() {}

// TODO (fix): What about onUpgrade?
class Handler extends DecoratorHandler {
  #dispatch
  #opts

  #retryCount = 0
  #headersSent = false
  #errorSent = false

  #statusCode = 0
  #headers = null
  #trailers = null

  #abort
  #aborted = false
  #reason
  #resume

  #pos
  #end
  #etag
  #error

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
    this.#trailers = null

    if (!this.#headersSent) {
      this.#pos = null
      this.#end = null
      this.#etag = null
      this.#error = null
      this.#resume = null

      super.onConnect((reason) => {
        if (!this.#aborted) {
          this.#aborted = true
          if (this.#abort) {
            this.#abort(reason)
          } else {
            this.#reason = reason
          }
        }
      })
    }

    if (this.#aborted) {
      abort(this.#reason)
    } else {
      this.#abort = abort
    }
  }

  onHeaders(statusCode, headers, resume) {
    this.#statusCode = statusCode
    this.#headers = headers

    if (this.#error == null) {
      assert(this.#etag == null)
      assert(this.#pos == null)
      assert(this.#end == null)
      assert(this.#headersSent === false)

      if (headers.trailer) {
        return this.#onHeaders(statusCode, headers, resume)
      }

      const contentLength = headers['content-length'] ? Number(headers['content-length']) : null
      if (contentLength != null && !Number.isFinite(contentLength)) {
        return this.#onHeaders(statusCode, headers, resume)
      }

      if (statusCode === 206) {
        const range = parseRangeHeader(headers['content-range'])
        if (!range) {
          return this.#onHeaders(statusCode, headers, resume)
        }

        const { start, size, end = size } = range

        assert(start != null && Number.isFinite(start), 'content-range mismatch')
        assert(end != null && Number.isFinite(end), 'invalid content-length')
        assert(
          contentLength == null || end == null || contentLength === end - start,
          'content-range mismatch',
        )

        this.#pos = start
        this.#end = end ?? contentLength
        this.#etag = headers.etag
      } else if (statusCode === 200) {
        this.#pos = 0
        this.#end = contentLength
        this.#etag = headers.etag
      } else if (statusCode >= 400) {
        return true
      } else {
        return this.#onHeaders(statusCode, headers, resume)
      }

      // Weak etags are not useful for comparison nor cache
      // for instance not safe to assume if the response is byte-per-byte
      // equal
      if (this.#etag != null && this.#etag.startsWith('W/')) {
        this.#etag = null
      }

      assert(Number.isFinite(this.#pos))
      assert(this.#end == null || Number.isFinite(this.#end))

      this.#resume = resume

      return this.#onHeaders(statusCode, headers, () => this.#resume?.())
    } else if (statusCode === 206 || (this.#pos === 0 && statusCode === 200)) {
      assert(this.#etag != null || !this.#pos)

      if (this.#pos > 0 && this.#etag !== headers.etag) {
        throw this.#error
      }

      const contentRange = parseRangeHeader(headers['content-range'])
      if (!contentRange) {
        throw this.#error
      }

      const { start, size, end = size } = contentRange
      assert(this.#pos === start, 'content-range mismatch')
      assert(this.#end == null || this.#end === end, 'content-range mismatch')

      this.#resume = resume

      // TODO (fix): What if we were paused before the error?
      return true
    } else {
      throw this.#error
    }
  }

  onData(chunk) {
    if (this.#statusCode >= 400) {
      // TODO (fix): Limit the amount of data we read?
      return true
    }

    if (this.#pos != null) {
      this.#pos += chunk.byteLength
    }
    return super.onData(chunk)
  }

  onError(err) {
    this.#maybeRetry(err)
  }

  onComplete(trailers) {
    this.#trailers = trailers

    if (this.#statusCode >= 400) {
      this.#maybeRetry(null, this.#statusCode)
    } else {
      super.onComplete(trailers)
    }
  }

  #maybeError(err) {
    if (err) {
      this.#onError(err)
    } else {
      this.#onHeaders(this.#statusCode, this.#headers, noop)
      if (!this.#aborted) {
        super.onComplete(this.#trailers)
      }
    }
  }

  #maybeRetry(err, statusCode) {
    if (this.#aborted || isDisturbed(this.#opts.body) || (this.#pos && !this.#etag)) {
      this.#maybeError(err)
      return
    }

    if (!err) {
      // TOOD (fix): Avoid creating an Error and do onHeaders + onComplete.
      const stackTraceLimit = Error.stackTraceLimit
      Error.stackTraceLimit = 0
      try {
        err = createHttpError(statusCode ?? 500)
      } finally {
        Error.stackTraceLimit = stackTraceLimit
      }
    }

    let retryPromise
    try {
      retryPromise = retryFn(err, this.#retryCount, this.#opts)
    } catch (err) {
      retryPromise = Promise.reject(err)
    }

    if (retryPromise == null) {
      this.#maybeError(err)
      return
    }

    this.#error = err

    retryPromise
      .then((opts) => {
        if (this.#aborted) {
          this.#onError(this.#reason)
        } else if (isDisturbed(this.#opts.body)) {
          this.#onError(this.#error)
        } else if (!this.#headersSent) {
          this.#retryCount++
          this.#opts.logger?.debug({ err, retryCount: this.#retryCount }, 'retry response headers')
          this.#dispatch(this.#opts, this)
        } else {
          assert(Number.isFinite(this.#pos))
          assert(this.#end == null || (Number.isFinite(this.#end) && this.#end > 0))

          this.#opts = {
            ...this.#opts,
            ...opts,
            headers: {
              ...this.#opts.headers,
              ...opts?.headers,
              'if-match': this.#etag,
              range: `bytes=${this.#pos}-${this.#end ? this.#end - 1 : ''}`,
            },
          }

          this.#retryCount++
          this.#opts.logger?.debug({ err, retryCount: this.#retryCount }, 'retry response body')
          this.#dispatch(this.#opts, this)
        }
      })
      .catch((err) => {
        if (!this.#errorSent) {
          this.#onError(err)
        }
      })
  }

  #onError(err) {
    assert(!this.#errorSent)
    this.#errorSent = true
    super.onError(err)
  }

  #onHeaders(statusCode, headers, resume) {
    assert(!this.#headersSent)
    this.#headersSent = true
    return super.onHeaders(statusCode, headers, resume)
  }
}

export default () => (dispatch) => (opts, handler) =>
  opts.retry !== false &&
  !opts.upgrade &&
  (opts.method === 'HEAD' ||
    opts.method === 'GET' ||
    opts.method === 'PUT' ||
    opts.method === 'PATCH' ||
    opts.idempotent)
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)

async function retryFn(err, retryCount, opts) {
  let retryOpts = opts?.retry

  if (!retryOpts) {
    throw err
  }

  if (typeof retryOpts === 'function') {
    return retryOpts(err, retryCount, opts, () => retryFn(err, retryCount, opts))
  }

  if (typeof retryOpts === 'number') {
    retryOpts = { count: retryOpts }
  }

  const retryMax = retryOpts?.count ?? 8

  if (retryCount > retryMax) {
    throw err
  }

  const statusCode = err.statusCode ?? err.status ?? err.$metadata?.httpStatusCode ?? null

  if (statusCode && [420, 429, 502, 503, 504].includes(statusCode)) {
    let retryAfter = err.headers?.['retry-after'] ? err.headers['retry-after'] * 1e3 : null
    retryAfter = Number.isFinite(retryAfter) ? retryAfter : Math.min(10e3, retryCount * 1e3)
    if (retryAfter != null && Number.isFinite(retryAfter)) {
      return tp.setTimeout(retryAfter, undefined, { signal: opts.signal })
    } else {
      return null
    }
  }

  if (
    err.code &&
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ENETDOWN',
      'ENETUNREACH',
      'EHOSTDOWN',
      'EHOSTUNREACH',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
    ].includes(err.code)
  ) {
    return tp.setTimeout(Math.min(10e3, retryCount * 1e3), undefined, { signal: opts.signal })
  }

  if (err.message && ['other side closed'].includes(err.message)) {
    return tp.setTimeout(Math.min(10e3, retryCount * 1e3), undefined, { signal: opts.signal })
  }

  throw err
}
