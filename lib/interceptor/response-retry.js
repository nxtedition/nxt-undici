import assert from 'node:assert'
import { isDisturbed, parseHeaders, parseRangeHeader, retry as retryFn } from '../utils.js'
import { DecoratorHandler } from 'undici'

// TODO (fix): What about onUpgrade?
class Handler extends DecoratorHandler {
  #handler
  #dispatch
  #opts

  #retryCount = 0
  #headersSent = false
  #errorSent = false

  #abort
  #aborted = false
  #reason = null

  #pos
  #end
  #etag
  #error

  constructor(opts, { handler, dispatch }) {
    super(handler)

    this.#handler = handler
    this.#dispatch = dispatch
    this.#opts = opts
  }

  onConnect(abort) {
    if (!this.#headersSent) {
      this.#pos = null
      this.#end = null
      this.#etag = null
      this.#error = null

      this.#handler.onConnect((reason) => {
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

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    if (this.#error == null) {
      assert(this.#etag == null)
      assert(this.#pos == null)
      assert(this.#end == null)
      assert(this.#headersSent === false)

      if (headers.trailer) {
        return this.#onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
      }

      const contentLength = headers['content-length'] ? Number(headers['content-length']) : null
      if (contentLength != null && !Number.isFinite(contentLength)) {
        return this.#onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
      }

      if (statusCode === 206) {
        const range = parseRangeHeader(headers['content-range'])
        if (!range) {
          return this.#onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
        }

        const { start, size, end = size } = range

        assert(start != null && Number.isFinite(start), 'content-range mismatch')
        assert(end != null && Number.isFinite(end), 'invalid content-length')
        assert(
          contentLength == null || end == null || contentLength === end + 1 - start,
          'content-range mismatch',
        )

        this.#pos = start
        this.#end = end ?? contentLength
        this.#etag = headers.etag
      } else if (statusCode === 200) {
        this.#pos = 0
        this.#end = contentLength
        this.#etag = headers.etag
      } else {
        return this.#onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
      }

      // Weak etags are not useful for comparison nor cache
      // for instance not safe to assume if the response is byte-per-byte
      // equal
      if (this.#etag != null && this.#etag.startsWith('W/')) {
        this.#etag = null
      }

      assert(Number.isFinite(this.#pos))
      assert(this.#end == null || Number.isFinite(this.#end))

      return this.#onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
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

      // TODO (fix): What if we were paused before the error?
      return true
    } else {
      throw this.#error
    }
  }

  onData(chunk) {
    if (this.#pos != null) {
      this.#pos += chunk.byteLength
    }
    return this.#handler.onData(chunk)
  }

  onError(err) {
    if (this.#aborted || isDisturbed(this.#opts.body) || (this.#pos && !this.#etag)) {
      this.#onError(err)
      return
    }

    const retryPromise = retryFn(err, this.#retryCount++, { ...this.#opts.retry })
    if (retryPromise == null) {
      this.#onError(err)
      return
    }

    this.#error = err

    retryPromise
      .then(() => {
        if (this.#aborted) {
          this.#onError(this.#reason)
        } else if (isDisturbed(this.#opts.body)) {
          this.#onError(this.#error)
        } else if (!this.#headersSent) {
          this.#opts.logger?.debug({ retryCount: this.#retryCount }, 'retry response headers')
          this.#dispatch(this.#opts, this)
        } else {
          assert(Number.isFinite(this.#pos))
          assert(this.#end == null || Number.isFinite(this.#end))

          this.#opts = {
            ...this.#opts,
            headers: {
              ...this.#opts.headers,
              'if-match': this.#etag,
              range: `bytes=${this.#pos}-${this.#end ?? ''}`,
            },
          }

          this.#opts.logger?.debug({ retryCount: this.#retryCount }, 'retry response body')
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
    this.#handler.onError(err)
  }

  #onHeaders(...args) {
    assert(!this.#headersSent)
    this.#headersSent = true
    return this.#handler.onHeaders(...args)
  }
}

export default (dispatch) => (opts, handler) => {
  // TODO (fix): HEAD, PUT, PATCH, DELETE, OPTIONS?
  return opts.retry && opts.method === 'GET' && !opts.upgrade
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)
}

export function isConnectionError(err) {
  // AWS compat.
  const statusCode = err?.statusCode ?? err?.$metadata?.httpStatusCode
  return err
    ? err.code === 'ECONNRESET' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND' ||
        err.code === 'ENETDOWN' ||
        err.code === 'ENETUNREACH' ||
        err.code === 'EHOSTDOWN' ||
        err.code === 'EHOSTUNREACH' ||
        err.code === 'EPIPE' ||
        err.message === 'other side closed' ||
        statusCode === 420 ||
        statusCode === 429 ||
        statusCode === 502 ||
        statusCode === 503 ||
        statusCode === 504
    : false
}
