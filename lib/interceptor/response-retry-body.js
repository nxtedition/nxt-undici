import assert from 'node:assert'
import { parseContentRange, isDisturbed, findHeader, retry as retryFn } from '../utils.js'

class Handler {
  constructor(opts, { dispatch, handler }) {
    this.dispatch = dispatch
    this.handler = handler
    this.opts = opts

    this.count = 0
    this.pos = 0
    this.end = null
    this.error = null
    this.etag = null

    this.headersSent = false

    this.reason = null
    this.aborted = false

    this.handler.onConnect((reason) => {
      this.aborted = true
      if (this.abort) {
        this.abort(reason)
      } else {
        this.reason = reason
      }
    })
  }

  onConnect(abort) {
    if (this.aborted) {
      abort(this.reason)
    } else {
      this.abort = abort
    }
  }

  onUpgrade(statusCode, rawHeaders, socket, headers) {
    return this.handler.onUpgrade(statusCode, rawHeaders, socket, headers)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers) {
    const etag = headers ? headers.etag : findHeader(rawHeaders, 'etag')

    if (this.resume) {
      this.resume = null

      // TODO (fix): Support other statusCode with skip?
      if (statusCode !== 206) {
        throw this.error
      }

      // TODO (fix): strict vs weak etag?
      if (this.etag == null || this.etag !== etag) {
        throw this.error
      }

      const contentRange = parseContentRange(
        headers ? headers['content-range'] : findHeader(rawHeaders, 'content-range'),
      )
      if (!contentRange) {
        throw this.error
      }

      const { start, size, end = size } = contentRange

      assert(this.pos === start, 'content-range mismatch')
      assert(this.end == null || this.end === end, 'content-range mismatch')

      this.resume = resume
      return true
    }

    if (this.end == null) {
      if (statusCode === 206) {
        const contentRange = parseContentRange(
          headers ? headers['content-range'] : findHeader(rawHeaders, 'content-range'),
        )
        if (!contentRange) {
          assert(!this.headersSent)
          this.headersSent = true
          return this.handler.onHeaders(
            statusCode,
            rawHeaders,
            () => this.resume(),
            statusMessage,
            headers,
          )
        }

        const { start, size, end = size } = contentRange

        this.end = end
        this.pos = Number(start)
      } else {
        const contentLength = headers
          ? headers['content-length']
          : findHeader(rawHeaders, 'content-length')
        if (contentLength) {
          this.end = Number(contentLength)
        }
      }

      assert(Number.isFinite(this.pos))
      assert(this.end == null || Number.isFinite(this.end), 'invalid content-length')
    }

    this.etag = etag
    this.resume = resume

    assert(!this.headersSent)
    this.headersSent = true
    return this.handler.onHeaders(
      statusCode,
      rawHeaders,
      () => this.resume(),
      statusMessage,
      headers,
    )
  }

  onData(chunk) {
    this.pos += chunk.length
    this.count = 0
    return this.handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    return this.handler.onComplete(rawTrailers)
  }

  onError(err) {
    if (this.aborted || !this.etag || isDisturbed(this.opts.body)) {
      return this.handler.onError(err)
    }

    const retryPromise = retryFn(err, this.count++, this.opts)
    if (retryPromise == null) {
      return this.handler.onError(err)
    }

    this.error = err
    this.opts = {
      ...this.opts,
      headers: {
        ...this.opts.headers,
        'if-match': this.etag,
        range: `bytes=${this.pos}-${this.end ?? ''}`,
      },
    }

    this.opts.logger?.debug({ retryCount: this.count }, 'retrying response body')

    retryPromise
      .then(() => {
        if (!this.aborted) {
          this.dispatch(this.opts, this)
        }
      })
      .catch((err) => {
        if (!this.aborted) {
          this.handler.onError(err)
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
