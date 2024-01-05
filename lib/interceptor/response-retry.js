import assert from 'node:assert'
import { isDisturbed, retry as retryFn } from '../utils.js'

class Handler {
  constructor(opts, { dispatch, handler }) {
    this.dispatch = dispatch
    this.handler = handler
    this.opts = opts

    this.headersSent = false
    this.count = 0

    this.reason = null
    this.aborted = false

    this.statusCode = null
    this.rawHeaders = null
    this.resume = null
    this.statusMessage = null
    this.headers = null

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
    assert(!this.headersSent)

    this.statusCode = statusCode
    this.rawHeaders = rawHeaders
    this.resume = resume
    this.statusMessage = statusMessage
    this.headers = headers

    return true
  }

  onData(chunk) {
    if (!this.headersSent) {
      this.sendHeaders()
    }

    return this.handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    if (!this.headersSent) {
      this.sendHeaders()
    }

    return this.handler.onComplete(rawTrailers)
  }

  onError(err) {
    if (this.aborted || this.headersSent || isDisturbed(this.opts.body)) {
      return this.handler.onError(err)
    }

    const retryPromise = retryFn(err, this.count++, this.opts)
    if (retryPromise == null) {
      return this.handler.onError(err)
    }

    this.opts.logger?.debug('retrying response')

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

  sendHeaders() {
    assert(!this.headersSent)

    this.headersSent = true
    this.handler.onHeaders(
      this.statusCode,
      this.rawHeaders,
      this.resume,
      this.statusMessage,
      this.headers,
    )

    this.statusCode = null
    this.rawHeaders = null
    this.resume = null
    this.statusMessage = null
    this.headers = null
  }
}

export default (dispatch) => (opts, handler) => {
  return opts.retry
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)
}
