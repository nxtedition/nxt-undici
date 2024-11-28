import createHttpError from 'http-errors'
import { DecoratorHandler, parseHeaders } from '../utils.js'

class Handler extends DecoratorHandler {
  #handler

  #statusCode = 0
  #contentType
  #decoder
  #headers
  #body = ''
  #opts
  #errored = false

  constructor(opts, { handler }) {
    super(handler)

    this.#opts = opts
    this.#handler = handler
  }

  onConnect(abort) {
    this.#statusCode = 0
    this.#contentType = null
    this.#decoder = null
    this.#headers = null
    this.#body = ''
    this.#errored = false

    return this.#handler.onConnect(abort)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    this.#statusCode = statusCode
    this.#headers = headers
    this.#contentType = headers['content-type']

    if (this.#statusCode < 400) {
      return this.#handler.onHeaders(statusCode, null, resume, statusMessage, headers)
    }

    // TODO (fix): Check content length
    if (this.#contentType === 'application/json' || this.#contentType === 'text/plain') {
      this.#decoder = new TextDecoder('utf-8')
    }
  }

  onData(chunk) {
    if (this.#statusCode >= 400) {
      this.#body += this.#decoder?.decode(chunk, { stream: true }) ?? ''
    } else {
      return this.#handler.onData(chunk)
    }
  }

  onComplete(rawTrailers) {
    if (this.#statusCode >= 400) {
      this.#body += this.#decoder?.decode(undefined, { stream: false }) ?? ''

      if (this.#contentType === 'application/json') {
        try {
          this.#body = JSON.parse(this.#body)
        } catch {
          // Do nothing...
        }
      }

      this.#errored = true

      let err

      const stackTraceLimit = Error.stackTraceLimit
      Error.stackTraceLimit = 0
      try {
        err = createHttpError(this.#statusCode)
      } finally {
        Error.stackTraceLimit = stackTraceLimit
      }
      this.#handler.onError(this.#decorateError(err))
    } else {
      this.#handler.onComplete(rawTrailers)
    }
  }

  onError(err) {
    if (this.#errored) {
      // Do nothing...
    } else {
      this.#handler.onError(this.#decorateError(err))
    }
  }

  #decorateError(err) {
    try {
      err.url ??= new URL(this.#opts.path, this.#opts.origin).href

      err.req = {
        method: this.#opts?.method,
        headers: this.#opts?.headers,
        body:
          // TODO (fix): JSON.stringify POJO
          typeof this.#opts?.body !== 'string' || this.#opts.body.length > 1024
            ? undefined
            : this.#opts.body,
      }

      err.res = {
        headers: this.#headers,
        // TODO (fix): JSON.stringify POJO
        body: typeof this.#body !== 'string' || this.#body.length < 1024 ? undefined : this.#body,
      }

      if (this.#body) {
        if (this.#body.reason != null) {
          err.reason ??= this.#body.reason
        }
        if (this.#body.code != null) {
          err.code ??= this.#body.code
        }
        if (this.#body.error != null) {
          err.error ??= this.#body.error
        }
      }

      return err
    } catch {
      return err
    }
  }
}

export default (opts) => (dispatch) => (opts, handler) =>
  opts.error !== false && opts.throwOnError !== false
    ? dispatch(opts, new Handler(opts, { handler }))
    : dispatch(opts, handler)
