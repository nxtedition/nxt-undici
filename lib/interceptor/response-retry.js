import assert from 'node:assert'
import { DecoratorHandler, isDisturbed, parseRangeHeader, retry as retryFn } from '../utils.js'

// TODO (fix): What about onUpgrade?
class Handler extends DecoratorHandler {
  #dispatch
  #opts

  #retryCount = 0
  #headersSent = false
  #errorSent = false

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
    if (this.#pos != null) {
      this.#pos += chunk.byteLength
    }
    return super.onData(chunk)
  }

  onError(err) {
    if (this.#aborted || isDisturbed(this.#opts.body) || (this.#pos && !this.#etag)) {
      this.#onError(err)
      return
    }

    let retryPromise
    try {
      retryPromise = retryFn(err, this.#retryCount, this.#opts)
    } catch (err) {
      retryPromise = Promise.reject(err)
    }

    if (retryPromise == null) {
      this.#onError(err)
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
  // TODO (fix): HEAD, PUT, PATCH, DELETE, OPTIONS?
  opts.retry !== false && opts.method === 'GET' && !opts.upgrade
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)
