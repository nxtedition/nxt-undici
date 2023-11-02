const { isStream } = require('../utils')

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
      return this.onConnect(abort)
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
    return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage)
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

function dispatchImpl(dispatch, opts, handler) {
  if (typeof opts.body === 'function') {
    Promise.resolve(opts.body({ signal: opts.signal })).then(
      (body) => dispatchImpl({ ...opts, body }, handler),
      (err) => handler.onError(err),
    )
  } else if (isStream(opts.body)) {
    if (opts.method === 'GET' || opts.method === 'HEAD') {
      opts.body.resume() // dump
      dispatch({ ...opts, body: undefined }, new Handler(opts, { handler }))
    } else {
      dispatch(opts, new Handler(opts, { handler }))
    }
  } else {
    dispatch(opts, handler)
  }
}

module.exports = (dispatch) => (opts, handler) => dispatchImpl(dispatch, opts, handler)
