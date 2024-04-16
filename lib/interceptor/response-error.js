import assert from 'node:assert'
import { parseHeaders } from '../utils.js'
import createHttpError from 'http-errors'
import { DecoratorHandler } from 'undici'

class Handler extends DecoratorHandler {
  #handler

  #statusCode
  #contentType
  #decoder
  #headers
  #body
  #error

  constructor(opts, { handler }) {
    super(handler)

    this.#handler = handler
  }

  onConnect(abort) {
    this.#statusCode = 0
    this.#contentType = null
    this.#decoder = null
    this.#headers = null
    this.#body = ''
    this.#error = null

    return this.#handler.onConnect(abort)
  }

  onUpgrade(statusCode, rawHeaders, socket, headers) {
    return this.#handler.onUpgrade(statusCode, rawHeaders, socket, headers)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    assert(statusCode >= 200)

    this.#statusCode = statusCode
    this.#headers = headers
    this.#contentType = headers['content-type']

    if (this.#statusCode >= 400) {
      this.#error = createHttpError(this.#statusCode)
      if (this.#contentType === 'application/json' || this.#contentType === 'text/plain') {
        this.#decoder = new TextDecoder('utf-8')
      }
    } else {
      return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
    }
  }

  onData(chunk) {
    if (this.#error) {
      this.#body += this.#decoder?.decode(chunk, { stream: true }) ?? ''
    } else {
      return this.#handler.onData(chunk)
    }
  }

  onComplete(rawTrailers) {
    this.onFinally(this.#error, rawTrailers)
  }

  onError(err) {
    this.onFinally(err, null)
  }

  onFinally(err, rawTrailers) {
    if (err) {
      this.#body += this.#decoder?.decode(undefined, { stream: false }) ?? ''

      if (this.#contentType === 'application/json') {
        try {
          this.#body = JSON.parse(this.#body)
        } catch {
          // Do nothing...
        }
      }

      this.#handler.onError(
        Object.assign(err, {
          reason: this.#body?.reason,
          error: this.#body?.error,
          headers: this.#headers,
          body: this.#body,
        }),
      )
    } else {
      this.#handler.onComplete(rawTrailers)
    }
  }
}

export default (dispatch) => (opts, handler) => dispatch(opts, new Handler(opts, { handler }))
