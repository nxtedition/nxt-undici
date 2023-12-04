import { isStream } from '../utils.js'

class Handler {
  constructor(opts, { handler }) {
    this.handler = handler
    this.body = opts.body
    this.error = null
    this.abort = null

    this.errorHandler = (err) => {
      if (this.abort) {
        this.abort(err)
      } else {
        this.error = err
      }
    }

    this.body.on('error', this.errorHandler)
  }

  onConnect(abort) {
    if (this.error) {
      abort(this.error)
    } else {
      this.abort = abort
      return this.handler.onConnect(abort)
    }
  }

  onUpgrade(statusCode, rawHeaders, socket, headers) {
    return this.handler.onUpgrade(statusCode, rawHeaders, socket, headers)
  }

  onBodySent(chunk) {
    return this.handler.onBodySent(chunk)
  }

  onRequestSent() {
    return this.handler.onRequestSent()
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers) {
    return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
  }

  onData(chunk) {
    return this.handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    this.body.off('error', this.errorHandler)
    return this.handler.onComplete(rawTrailers)
  }

  onError(err) {
    this.body.off('error', this.errorHandler)
    return this.handler.onError(err)
  }
}

export default (dispatch) => (opts, handler) => {
  if (isStream(opts.body)) {
    if (opts.method === 'GET' || opts.method === 'HEAD') {
      opts.body.resume() // dump
      return dispatch({ ...opts, body: undefined }, new Handler(opts, { handler }))
    } else {
      return dispatch(opts, new Handler(opts, { handler }))
    }
  } else {
    return dispatch(opts, handler)
  }
}
