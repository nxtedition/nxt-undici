const crypto = require('node:crypto')

class Handler {
  constructor(opts, { handler, md5, length }) {
    this.handler = handler
    this.md5 = md5
    this.length = length
    this.hasher = this.md5 ? crypto.createHash('md5') : null
    this.pos = 0
  }

  onConnect(abort) {
    return this.handler.onConnect(abort)
  }

  onUpgrade(statusCode, rawHeaders, socket) {
    return this.handler.onUpgrade(statusCode, rawHeaders, socket)
  }

  onBodySent(chunk) {
    this.pos += chunk.length
    this.hasher?.update(chunk)
    return this.handler.onBodySent(chunk)
  }

  onRequestSent() {
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
    this.handler.onError(err)
  }
}

module.exports = (dispatch) => (opts, handler) => {
  if (opts.upgrade) {
    return dispatch(opts, handler)
  }

  // TODO (fix): case-insensitive check?
  const md5 = opts.headers?.['content-md5'] ?? opts.headers?.['Content-MD5']
  const length = opts.headers?.['content-lenght'] ?? opts.headers?.['Content-Length']

  return md5 != null || length != null
    ? dispatch(opts, new Handler(opts, { handler, md5, length }))
    : dispatch(opts, handler)
}
