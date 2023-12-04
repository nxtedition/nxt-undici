import crypto from 'node:crypto'
import { findHeader } from '../utils.js'

class Handler {
  constructor(opts, { handler, md5, length }) {
    this.handler = handler
    this.md5 = md5
    this.length = length
    this.hasher = this.md5 ? crypto.createHash('md5') : null
    this.pos = 0
    this.abort = null
  }

  onConnect(abort) {
    this.abort = abort

    return this.handler.onConnect(abort)
  }

  onUpgrade(statusCode, rawHeaders, socket, headers) {
    return this.handler.onUpgrade(statusCode, rawHeaders, socket, headers)
  }

  onBodySent(chunk) {
    this.pos += chunk.length
    this.hasher?.update(chunk)

    return this.handler.onBodySent(chunk)
  }

  onRequestSent() {
    const hash = this.hasher?.digest('base64')

    if (this.length != null && this.pos !== Number(this.length)) {
      this.abort(
        Object.assign(new Error('Request Content-Length mismatch'), {
          expected: Number(this.length),
          actual: this.pos,
        }),
      )
    }

    if (this.md5 != null && hash !== this.md5) {
      this.abort(
        Object.assign(new Error('Request Content-MD5 mismatch'), {
          expected: this.md5,
          actual: hash,
        }),
      )
    }

    return this.handler.onRequestSent()
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers) {
    return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
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

export default (dispatch) => (opts, handler) => {
  if (opts.upgrade) {
    return dispatch(opts, handler)
  }

  // TODO (fix): case-insensitive check?
  const md5 = findHeader(opts.headers, 'content-md5')
  const length = findHeader(opts.headers, 'content-length')

  return md5 != null || length != null
    ? dispatch(opts, new Handler(opts, { handler, md5, length }))
    : dispatch(opts, handler)
}
