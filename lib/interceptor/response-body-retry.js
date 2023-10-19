const assert = require('node:assert')
const { parseContentRange, isDisturbed, findHeader, retry: retryFn } = require('../utils.js')

class Handler {
  constructor(opts, { dispatch, handler }) {
    this.dispatch = dispatch
    this.handler = handler
    this.opts = opts
    this.abort = null
    this.aborted = false
    this.reason = null

    this.retryCount = 0
    this.retryPromise = null

    this.pos = 0
    this.end = null
    this.error = null
    this.etag = null

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

  onUpgrade(statusCode, rawHeaders, socket) {
    return this.handler.onUpgrade(statusCode, rawHeaders, socket)
  }

  onBodySent(chunk) {
    return this.handler.onBodySent(chunk)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage) {
    const etag = findHeader(rawHeaders, 'etag')

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

      const contentRange = parseContentRange(findHeader(rawHeaders, 'content-range'))
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
        const contentRange = parseContentRange(findHeader(rawHeaders, 'content-range'))
        if (!contentRange) {
          return this.handler.onHeaders(statusCode, rawHeaders, () => this.resume(), statusMessage)
        }

        const { start, size, end = size } = contentRange

        this.end = end
        this.pos = Number(start)
      } else {
        const contentLength = findHeader(rawHeaders, 'content-length')
        if (contentLength) {
          this.end = Number(contentLength)
        }
      }

      assert(Number.isFinite(this.pos))
      assert(this.end == null || Number.isFinite(this.end), 'invalid content-length')
    }

    this.etag = etag
    this.resume = resume
    return this.handler.onHeaders(statusCode, rawHeaders, () => this.resume(), statusMessage)
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
    if (!this.resume || this.aborted || !this.etag || isDisturbed(this.opts.body)) {
      return this.handler.onError(err)
    }

    // TODO (fix): abort signal?
    const retryPromise = retryFn(err, this.retryCount++, this.opts)
    if (retryPromise == null) {
      return this.handler.onError(err)
    }

    retryPromise
      .then(() => {
        if (!this.aborted) {
          try {
            this.dispatch(this.opts, this)
          } catch (err2) {
            this.handler.onError(new AggregateError([err, err2]))
          }
        }
      })
      .catch((err) => {
        if (!this.aborted) {
          this.handler.onError(err)
        }
      })

    this.error = err
    this.opts = {
      ...this.opts,
      headers: {
        ...this.opts.headers,
        'if-match': this.etag,
        range: `bytes=${this.pos}-${this.end ?? ''}`,
      },
    }

    this.opts.logger?.debug('retrying response body')
  }
}

module.exports = (dispatch) => (opts, handler) => {
  return opts.idempotent && opts.retry && opts.method === 'GET' && !opts.upgrade
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)
}
