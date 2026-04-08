import crypto from 'node:crypto'
import { DecoratorHandler, parseContentRange } from '../utils.js'

class Handler extends DecoratorHandler {
  #verifyOpts
  #contentMD5
  #expectedSize
  #hasher
  #pos = 0

  constructor(opts, { handler }) {
    super(handler)

    this.#verifyOpts = opts.verify === true ? { hash: true, size: true } : opts.verify
  }

  onConnect(abort) {
    this.#contentMD5 = null
    this.#expectedSize = null
    this.#hasher = null
    this.#pos = 0

    super.onConnect(abort)
  }

  onHeaders(statusCode, headers, resume) {
    this.#contentMD5 = this.#verifyOpts.hash ? headers['content-md5'] : null

    if (this.#verifyOpts.size) {
      const contentRange = parseContentRange(headers['content-range'])
      if (contentRange?.start != null && contentRange?.end != null) {
        this.#expectedSize = contentRange.end - contentRange.start
      } else if (headers['content-length'] != null) {
        this.#expectedSize = Number(headers['content-length'])
      }
    }

    this.#hasher = this.#contentMD5 != null ? crypto.createHash('md5') : null

    return super.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    this.#pos += chunk.length
    this.#hasher?.update(chunk)

    if (this.#expectedSize != null && this.#pos > this.#expectedSize) {
      super.onError(
        Object.assign(new Error('Response body exceeded Content-Range'), {
          expected: this.#expectedSize,
          actual: this.#pos,
        }),
      )
      return false
    }

    return super.onData(chunk)
  }

  onComplete(trailers) {
    const contentMD5 = this.#hasher?.digest('base64')

    if (this.#expectedSize != null && this.#pos !== this.#expectedSize) {
      super.onError(
        Object.assign(new Error('Response body size mismatch'), {
          expected: this.#expectedSize,
          actual: this.#pos,
        }),
      )
    } else if (this.#contentMD5 != null && contentMD5 !== this.#contentMD5) {
      super.onError(
        Object.assign(new Error('Response Content-MD5 mismatch'), {
          expected: this.#contentMD5,
          actual: contentMD5,
        }),
      )
    } else {
      super.onComplete(trailers)
    }
  }
}

export default () => (dispatch) => (opts, handler) =>
  !opts.upgrade && opts.verify && opts.method !== 'HEAD'
    ? dispatch(opts, new Handler(opts, { handler }))
    : dispatch(opts, handler)
