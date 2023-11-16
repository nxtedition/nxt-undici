import crypto from 'node:crypto'
import { findHeader } from '../utils.js'

class Handler {
  constructor(opts, { handler }) {
    this.handler = handler
    this.md5 = null
    this.length = null
    this.hasher = null
    this.pos = 0
  }

  onConnect(abort) {
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
    this.md5 = findHeader(rawHeaders, 'content-md5')
    this.length = findHeader(rawHeaders, 'content-length')
    this.hasher = this.md5 != null ? crypto.createHash('md5') : null
    return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage)
  }

  onData(chunk) {
    this.pos += chunk.length
    this.hasher?.update(chunk)
    return this.handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    const hash = this.hasher?.digest('base64')
    if (this.md5 != null && hash !== this.md5) {
      this.handler.onError(
        Object.assign(new Error('Request Content-Length mismatch'), {
          expected: this.md5,
          actual: hash,
        }),
      )
    }
    if (this.length != null && this.pos !== Number(this.length)) {
      return this.handler.onError(
        Object.assign(new Error('Request Content-Length mismatch'), {
          expected: Number(this.length),
          actual: this.pos,
        }),
      )
    }
    return this.handler.onComplete(rawTrailers)
  }

  onError(err) {
    this.handler.onError(err)
  }
}

export default (dispatch) => (opts, handler) =>
  !opts.upgrade ? dispatch(opts, new Handler(opts, { handler })) : dispatch(opts, handler)
