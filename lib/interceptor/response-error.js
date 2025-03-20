import { DecoratorHandler, decorateError } from '../utils.js'

class Handler extends DecoratorHandler {
  #statusCode = 0
  #decoder
  #headers
  #trailers
  #body = ''
  #opts

  constructor(opts, { handler }) {
    super(handler)

    this.#opts = opts
  }

  onConnect(abort) {
    this.#statusCode = 0
    this.#decoder = null
    this.#headers = null
    this.#body = ''

    super.onConnect(abort)
  }

  onHeaders(statusCode, headers, resume) {
    this.#statusCode = statusCode
    this.#headers = headers

    if (this.#statusCode < 400) {
      return super.onHeaders(statusCode, headers, resume)
    }

    if (
      this.#headers['content-type']?.startsWith('application/json') ||
      this.#headers['content-type']?.startsWith('text/plain')
    ) {
      this.#decoder = new TextDecoder('utf-8')
      this.#body = ''
    }
  }

  onData(chunk) {
    if (this.#statusCode < 400) {
      return super.onData(chunk)
    }

    this.#body += this.#decoder?.decode(chunk, { stream: true }) ?? ''
  }

  onComplete(trailers) {
    this.#trailers = trailers

    if (this.#statusCode < 400) {
      return super.onComplete(trailers)
    }

    this.#body += this.#decoder?.decode(undefined, { stream: false }) ?? ''

    super.onError(
      decorateError(null, this.#opts, {
        statusCode: this.#statusCode,
        headers: this.#headers,
        trailers: this.#trailers,
        body: this.#body,
      }),
    )
  }

  onError(err) {
    super.onError(
      decorateError(err, this.#opts, {
        statusCode: this.#statusCode,
        headers: this.#headers,
        trailers: this.#trailers,
        body: null,
      }),
    )
  }
}

export default () => (dispatch) => (opts, handler) =>
  opts.throwOnError !== false && opts.error !== false
    ? dispatch(opts, new Handler(opts, { handler }))
    : dispatch(opts, handler)
