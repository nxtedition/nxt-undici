const { AbortError } = require('../utils')

// TODO (fix): Configurable timeout
// TODO (fix): Dump?

class Handler {
  constructor(opts, { handler }) {
    this.opts = opts
    this.handler = handler
    this.pos = 0
    this.reason = null
    this.timeout = null
  }

  onConnect(abort) {
    this.abort = abort
    this.handler.onConnect((reason) => {
      this.reason = reason ?? new AbortError()
      this.timeout = setTimeout(() => {
        this.timeout = null
        this.abort(this.reason)
      }, this.opts.dump?.timeout ?? 10e3)
    })
  }

  onBodySent(chunk) {
    return this.handler.onBodySent(chunk)
  }

  onRequestSent() {
    return this.handler.onRequestSent()
  }

  onUpgrade(statusCode, rawHeaders, socket) {
    return this.handler.onUpgrade(statusCode, rawHeaders, socket)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage) {
    if (this.reason == null) {
      const ret = this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage)
      if (this.reason == null) {
        return ret
      }
    }

    return true
  }

  onData(chunk) {
    if (this.reason == null) {
      const ret = this.handler.onData(chunk)
      if (this.reason == null) {
        return ret
      }
    }

    this.pos += chunk.length
    if (this.pos < 128 * 1024) {
      return true
    }

    this.abort(this.reason)

    return false
  }

  onComplete(rawTrailers) {
    return this.onFinally(this.reason, rawTrailers)
  }

  onError(err) {
    return this.onFinally(err)
  }

  onFinally(err, rawTrailers) {
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }

    return err == null ? this.handler.onComplete(rawTrailers) : this.handler.onError(err)
  }
}

module.exports = (dispatch) => (opts, handler) =>
  opts.dump ? dispatch(opts, new Handler(opts, { handler })) : dispatch(opts, handler)
