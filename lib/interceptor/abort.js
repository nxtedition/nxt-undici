import { AbortError } from '../utils.js'

class Handler {
  constructor(opts, { handler }) {
    this.opts = opts
    this.handler = handler
    this.pos = 0
    this.reason = null
  }

  onConnect(abort) {
    this.abort = abort
    this.handler.onConnect((reason) => {
      this.reason = reason ?? new AbortError()
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
    return err == null ? this.handler.onComplete(rawTrailers) : this.handler.onError(err)
  }
}

export default (dispatch) => (opts, handler) => dispatch(opts, new Handler(opts, { handler }))
