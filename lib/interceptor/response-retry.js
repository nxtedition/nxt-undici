import assert from 'node:assert'
import tp from 'node:timers/promises'
import { DecoratorHandler, isDisturbed, decorateError, parseRangeHeader } from '../utils.js'

function noop() {}

// TODO (fix): What about onUpgrade?
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
        const range = parseRangeHeader(headers['content-range'])
        if (!range) {
          this.#headersSent = true
          return super.onHeaders(statusCode, headers, resume)
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
        this.#body = []
        this.#bodySize = 0
        return true
      } else {
        this.#headersSent = true
        return super.onHeaders(statusCode, headers, resume)
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

      this.#headersSent = true
      return super.onHeaders(statusCode, headers, () => this.#resume?.())
    } else if (statusCode === 206 || (this.#pos === 0 && statusCode === 200)) {
      assert(this.#etag != null || !this.#pos)

      if (this.#pos > 0 && this.#etag !== headers.etag) {
        this.#maybeError(null)
        return null
      }

      const contentRange = parseRangeHeader(headers['content-range'])
      if (!contentRange) {
        this.#maybeError(null)
        return null
      }

      const { start, size, end = size } = contentRange
      assert(this.#pos === start, 'content-range mismatch')
      assert(this.#end == null || this.#end === end, 'content-range mismatch')

      this.#resume = resume

      // TODO (fix): What if we were paused before the error?
      return true
    } else {
      this.#maybeError(this.#retryError)
    }
  }

  onData(chunk) {
    if (this.#pos != null) {
      this.#pos += chunk.byteLength
    }

    if (this.#statusCode < 400) {
      return super.onData(chunk)
    }

    if (this.#body) {
      this.#body.push(chunk)
      this.#bodySize += chunk.byteLength
      if (this.#bodySize > 256 * 1024) {
        this.#body = null
        this.#bodySize = 0
      }
    }
  }

  onComplete(trailers) {
    this.#trailers = trailers

    if (this.#statusCode < 400) {
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
    }

    this.#maybeAbort(err)
  }

  #maybeRetry(err) {
    if (this.#aborted || isDisturbed(this.#opts.body) || (this.#pos && !this.#etag)) {
      this.#maybeError(err)
      return
    }

    let retryPromise
    try {
      if (typeof this.#opts.retry === 'function') {
        retryPromise = this.#opts.retry(
          decorateError(err, this.#opts, {
            statusCode: this.#statusCode,
            headers: this.#headers,
            trailers: this.#trailers,
            body: this.#body,
          }),
          this.#retryCount,
          this.#opts,
          () => this.#retryFn(err, this.#retryCount, this.#opts),
        )
      } else {
        retryPromise = this.#retryFn(err, this.#retryCount, this.#opts)
      }
    } catch (err) {
      retryPromise = Promise.reject(err)
    }

    if (retryPromise == null) {
      this.#maybeError(err)
      return
    }

    retryPromise
      .then((shouldRetry) => {
        if (this.#aborted) {
          this.#maybeError(this.#reason)
        } else if (shouldRetry === false || isDisturbed(this.#opts.body)) {
          this.#maybeError(err)
        } else if (!this.#headersSent) {
          this.#opts.logger?.debug({ err, retryCount: this.#retryCount }, 'retry response headers')

          this.#retryCount++
          this.#retryError = err

          this.#dispatch(this.#opts, this)
        } else {
          assert(Number.isFinite(this.#pos))
          assert(this.#end == null || (Number.isFinite(this.#end) && this.#end > 0))

          this.#opts.headers['if-match'] = this.#etag
          this.#opts.headers.range = `bytes=${this.#pos}-${this.#end ? this.#end - 1 : ''}`
          this.#opts.logger?.debug({ err, retryCount: this.#retryCount }, 'retry response body')

          this.#retryCount++
          this.#retryError = err

          this.#dispatch(this.#opts, this)
        }
      })
      .catch((err) => {
        this.#maybeError(err)
      })
  }

  async #retryFn(err, retryCount, opts) {
    let retryOpts = opts?.retry

    if (!retryOpts) {
      return false
    }

    if (typeof retryOpts === 'number') {
      retryOpts = { count: retryOpts }
    }

    const retryMax = retryOpts?.count ?? 8

    if (retryCount > retryMax) {
      return false
    }

    const statusCode =
      err?.statusCode ?? err?.status ?? err?.$metadata?.httpStatusCode ?? this.#statusCode
    const headers = err?.headers ?? this.#headers

    if (statusCode && [420, 429, 502, 503, 504].includes(statusCode)) {
      const retryAfter = headers?.['retry-after'] ? Number(headers['retry-after']) * 1e3 : null
      const delay =
        retryAfter != null && Number.isFinite(retryAfter)
          ? retryAfter
          : Math.min(10e3, retryCount * 1e3)
      return tp.setTimeout(delay, true, { signal: opts.signal })
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
        'ENODATA',
        'UND_ERR_CONNECT_TIMEOUT',
      ].includes(err.code)
    ) {
      return tp.setTimeout(Math.min(10e3, retryCount * 1e3), true, { signal: opts.signal })
    }

    if (err?.message && ['other side closed'].includes(err.message)) {
      return tp.setTimeout(Math.min(10e3, retryCount * 1e3), true, { signal: opts.signal })
    }

    return false
  }
}

export default () => (dispatch) => (opts, handler) =>
  opts.retry !== false &&
  !opts.upgrade &&
  (/^(HEAD|GET|PUT|PATCH)$/.test(opts.method) || opts.idempotent)
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)
