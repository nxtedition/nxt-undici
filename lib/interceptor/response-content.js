import crypto from 'node:crypto'
import { findHeader } from '../utils.js'
import { DecoratorHandler } from 'undici'

class Handler extends DecoratorHandler {
  constructor(opts, { handler }) {
    super(handler)

    this.handler = handler
    this.opts = opts
    this.md5 = null
    this.length = null
    this.hasher = null
    this.pos = 0
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers) {
    this.md5 = headers ? headers['content-md5'] : findHeader(rawHeaders, 'content-md5')
    this.length = headers ? headers['content-length'] : findHeader(rawHeaders, 'content-length')
    this.hasher = this.md5 != null ? crypto.createHash('md5') : null

    return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
  }

  onData(chunk) {
    this.pos += chunk.length
    this.hasher?.update(chunk)

    return this.handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    const hash = this.hasher?.digest('base64')

    if (this.length != null && this.pos !== Number(this.length)) {
      throw Object.assign(new Error('Request Content-Length mismatch'), {
        expected: Number(this.length),
        actual: this.pos,
      })
    } else if (this.md5 != null && hash !== this.md5) {
      throw Object.assign(new Error('Request Content-MD5 mismatch'), {
        expected: this.md5,
        actual: hash,
      })
    } else {
      return this.handler.onComplete(rawTrailers)
    }
  }
}

export default (dispatch) => (opts, handler) =>
  !opts.upgrade ? dispatch(opts, new Handler(opts, { handler })) : dispatch(opts, handler)
