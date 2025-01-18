import crypto from 'node:crypto'
import assert from 'node:assert'
import { DecoratorHandler } from '../utils.js'

class Handler extends DecoratorHandler {
  #verifyOpts
  #contentMD5
  #contentLength
  #hasher
  #pos = 0

  constructor(opts, { handler }) {
    super(handler)

    this.#verifyOpts = opts.verify === true ? { hash: true, size: true } : opts.verify
  }

  onConnect(abort) {
    assert(!this.#pos)

    this.#contentMD5 = null
    this.#contentLength = null
    this.#hasher = null
    this.#pos = 0

    super.onConnect(abort)
  }

  onHeaders(statusCode, headers, resume) {
    this.#contentMD5 = this.#verifyOpts.hash ? headers['content-md5'] : null
    this.#contentLength = this.#verifyOpts.size ? headers['content-length'] : null
    this.#hasher = this.#contentMD5 != null ? crypto.createHash('md5') : null

    return super.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    this.#pos += chunk.length
    this.#hasher?.update(chunk)

    return super.onData(chunk)
  }

  onComplete() {
    const contentMD5 = this.#hasher?.digest('base64')

    if (this.#contentLength != null && this.#pos !== Number(this.#contentLength)) {
      super.onError(
        Object.assign(new Error('Request Content-Length mismatch'), {
          expected: Number(this.#contentLength),
          actual: this.#pos,
        }),
      )
    } else if (this.#contentMD5 != null && contentMD5 !== this.#contentMD5) {
      super.onError(
        Object.assign(new Error('Request Content-MD5 mismatch'), {
          expected: this.#contentMD5,
          actual: contentMD5,
        }),
      )
    } else {
      super.onComplete()
    }
  }
}

export default () => (dispatch) => (opts, handler) =>
  !opts.upgrade && opts.verify && opts.method !== 'HEAD'
    ? dispatch(opts, new Handler(opts, { handler }))
    : dispatch(opts, handler)
