import { DecoratorHandler, decorateError } from '../utils.js'

const MAX_ERROR_BODY_SIZE = 256 * 1024

class Handler extends DecoratorHandler {
  #statusCode = 0
  #decoder
  #headers
  #trailers
  #body = ''
  #bodySize = 0
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
    this.#bodySize = 0

    super.onConnect(abort)
  }

  onHeaders(statusCode, headers, resume) {
    this.#statusCode = statusCode
    this.#headers = headers

    if (this.#statusCode < 400) {
      return super.onHeaders(statusCode, headers, resume)
    }

    // A duplicated content-type header is an array; .startsWith would throw
    // synchronously out of this parser callback. Coerce to the first value.
    const contentType = Array.isArray(this.#headers['content-type'])
      ? this.#headers['content-type'][0]
      : this.#headers['content-type']
    if (contentType?.startsWith('application/json') || contentType?.startsWith('text/plain')) {
      this.#decoder = new TextDecoder('utf-8')
      this.#body = ''
    }

    return true
  }

  onData(chunk) {
    if (this.#statusCode < 400) {
      return super.onData(chunk)
    }

    if (this.#decoder) {
      this.#bodySize += chunk.byteLength
      if (this.#bodySize <= MAX_ERROR_BODY_SIZE) {
        this.#body += this.#decoder.decode(chunk, { stream: true })
      }
    }
  }

  onComplete(trailers) {
    this.#trailers = trailers

    if (this.#statusCode < 400) {
      return super.onComplete(trailers)
    }

    this.#body += this.#decoder?.decode(undefined, { stream: false }) ?? ''

    super.onError(
      decorateError(null, this.#opts, {
        statusCode: this.#statusCode || undefined,
        headers: this.#headers,
        trailers: this.#trailers,
        body: this.#body,
      }),
    )
  }

  onError(err) {
    super.onError(
      decorateError(err, this.#opts, {
        statusCode: this.#statusCode || undefined,
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
