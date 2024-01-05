import { findHeader, parseHeaders } from '../utils.js'
import createHttpError from 'http-errors'

class Handler {
  constructor(opts, { handler }) {
    this.handler = handler
    this.statusCode = 0
    this.contentType = null
    this.decoder = null
    this.headers = null
    this.body = null
  }

  onConnect(abort) {
    return this.handler.onConnect(abort)
  }

  onUpgrade(statusCode, rawHeaders, socket, headers) {
    return this.handler.onUpgrade(statusCode, rawHeaders, socket, headers)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    if (statusCode >= 400) {
      this.statusCode = statusCode
      this.headers = headers
      this.contentType = findHeader(rawHeaders, 'content-type')
      if (this.contentType === 'application/json' || this.contentType === 'text/plain') {
        this.decoder = new TextDecoder('utf-8')
        this.body = ''
      }
    } else {
      return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
    }
  }

  onData(chunk) {
    if (this.statusCode) {
      if (this.decoder) {
        // TODO (fix): Limit body size?
        this.body += this.decoder.decode(chunk, { stream: true })
      }
      return true
    } else {
      return this.handler.onData(chunk)
    }
  }

  onComplete(rawTrailers) {
    this.onFinally(null, rawTrailers)
  }

  onError(err) {
    this.onFinally(err, null)
  }

  onFinally(err, rawTrailers) {
    if (this.statusCode) {
      if (this.decoder != null) {
        this.body += this.decoder.decode(undefined, { stream: false })
        if (this.contentType === 'application/json') {
          this.body = JSON.parse(this.body)
        }
      }

      const stackTraceLimit = Error.stackTraceLimit
      Error.stackTraceLimit = 0
      try {
        this.handler.onError(
          createHttpError(this.statusCode, { headers: this.headers, body: this.body }),
        )
      } finally {
        Error.stackTraceLimit = stackTraceLimit
      }

      this.decoder = null
      this.contentType = null
      this.body = null
    } else if (err) {
      this.handler.onError(err)
    } else {
      this.handler.onComplete(rawTrailers)
    }

    this.handler = null
  }
}

export default (dispatch) => (opts, handler) => dispatch(opts, new Handler(opts, { handler }))
