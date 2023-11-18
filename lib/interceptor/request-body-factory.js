class Handler {
  constructor(opts, { handler, dispatch }) {
    this.handler = handler
    this.dispatch = dispatch
    this.ac = new AbortController()

    const signal = opts.signal ? AbortSignal.any([this.ac.signal, opts.signal]) : this.ac.signal

    const body = opts.body({ signal })

    if (typeof body.then === 'function') {
      body.then(
        (body) => this.dispatch({ ...opts, body }, handler),
        (err) => this.handler.onError(err),
      )
    } else {
      this.dispatch({ ...opts, body }, handler)
    }
  }

  onConnect(abort) {
    this.abort = (err) => {
      this.ac.abort(err)
      abort(err)
    }
    return this.handler.onConnect(abort)
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
    return this.handler.onComplete(rawTrailers)
  }

  onError(err) {
    return this.handler.onError(err)
  }
}

export default (dispatch) => (opts, handler) =>
  typeof opts.body === 'function'
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)
