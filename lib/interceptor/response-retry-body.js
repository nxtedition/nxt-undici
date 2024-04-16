import assert from 'node:assert'
import { isDisturbed, parseHeaders, parseRangeHeader, retry as retryFn } from '../utils.js'
import { DecoratorHandler } from 'undici'

class Handler extends DecoratorHandler {
  #dispatch
  #handler
  #opts
  #abort

  #retryCount = 0

  #headersSent = false
  #aborted = false
  #reason = null

  #pos
  #end
  #etag

  constructor(opts, { dispatch, handler }) {
    super(handler)

    this.#dispatch = dispatch
    this.#handler = handler
    this.#opts = opts

    this.#handler.onConnect((reason) => {
      this.#aborted = true
      if (this.#abort) {
        this.#abort(reason)
      } else {
        this.#reason = reason
      }
    })
  }

  onConnect(abort) {
    if (this.#aborted) {
      abort(this.#reason)
    } else {
      this.#abort = abort
    }
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    if (this.#reason == null) {
      assert(this.#etag == null)
      assert(this.#pos == null)
      assert(this.#end == null)
      assert(this.#headersSent === false)

      if (headers.trailer) {
        this.#headersSent = true
        return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
      }

      const contentLength = headers['content-length'] ? Number(headers['content-length']) : null
      if (contentLength != null && !Number.isFinite(contentLength)) {
        this.#headersSent = true
        return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
      }

      if (statusCode === 206) {
        const range = parseRangeHeader(headers['content-range'])
        if (!range) {
          this.#headersSent = true
          return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
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
        this.#headersSent = true
        return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
      }

      assert(Number.isFinite(this.#pos))
      assert(this.#end == null || Number.isFinite(this.#end))

      return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
    } else if (statusCode === 206 || (this.#pos === 0 && statusCode === 200)) {
      const etag = headers.etag
      if (this.#etag != null && this.#etag !== etag) {
        throw this.#reason
      }

      const contentRange = parseRangeHeader(headers['content-range'])
      if (!contentRange) {
        throw this.#reason
      }

      const { start, size, end = size } = contentRange
      assert(this.#pos === start, 'content-range mismatch')
      assert(this.#end == null || this.#end === end, 'content-range mismatch')

      return true
    } else {
      throw this.#reason
    }
  }

  onData(chunk) {
    if (this.#pos != null) {
      this.#pos += chunk.byteLength
    }
    return this.#handler.onData(chunk)
  }

  onError(err) {
    if (this.#aborted || isDisturbed(this.#opts.body)) {
      return this.#handler.onError(err)
    }

    const retryPromise = retryFn(err, this.#retryCount++, this.#opts)
    if (retryPromise == null) {
      return this.#handler.onError(err)
    }

    retryPromise
      .then(() => {
        if (this.#aborted || isDisturbed(this.#opts.body)) {
          this.#handler.onError(err)
        } else {
          assert(Number.isFinite(this.#pos))
          assert(this.#end == null || Number.isFinite(this.#end))

          this.#reason = err
          this.#opts = {
            ...this.#opts,
            headers: {
              ...this.#opts.headers,
              'if-match': this.#etag,
              range: `bytes=${this.#pos}-${this.#end ?? ''}`,
            },
          }

          this.#opts.logger?.debug({ retryCount: this.#retryCount }, 'retrying response body')

          this.#dispatch(this.#opts, this)
        }
      })
      .catch((err) => {
        if (!this.#aborted) {
          this.#handler.onError(err)
        }
      })
  }
}

export default (dispatch) => (opts, handler) => {
  return opts.idempotent && opts.retry && opts.method === 'GET' && !opts.upgrade
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
