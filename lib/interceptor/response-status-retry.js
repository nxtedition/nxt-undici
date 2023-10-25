const { parseHeaders, isDisturbed, retry: retryFn } = require('../utils')
const createError = require('http-errors')

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

  onRequestSent() {
    return this.handler.onRequestSent()
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage) {
    if (statusCode < 400) {
      return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage)
    }

    const err = createError(statusCode, { headers: parseHeaders(rawHeaders) })

    const retryPromise = retryFn(err, this.retryCount++, this.opts)
    if (retryPromise == null) {
      return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage)
    }

    retryPromise.catch(() => {})

    this.retryPromise = retryPromise

    this.abort(err)

    return false
  }

  onData(chunk) {
    return this.handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    return this.handler.onComplete(rawTrailers)
  }

  onError(err) {
    if (this.retryPromise == null || this.aborted || isDisturbed(this.opts.body)) {
      return this.handler.onError(err)
    }

    this.retryPromise
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
    this.retryPromise = null

    this.opts.logger?.debug('retrying response status')
  }
}

module.exports = (dispatch) => (opts, handler) =>
  opts.idempotent && opts.retry
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)
