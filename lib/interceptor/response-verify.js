import crypto from 'node:crypto'
import assert from 'node:assert'
import { DecoratorHandler, parseHeaders } from '../utils.js'

const DEFAULT_OPTS = { hash: null }

class Handler extends DecoratorHandler {
  #handler

  #verifyOpts
  #contentMD5
  #contentLength
  #hasher
  #pos = 0
  #errorSent = false

  constructor(opts, { handler }) {
    super(handler)

    this.#handler = handler
    this.#verifyOpts =
      opts.verify === true ? { hash: true, size: true } : (opts.verify ?? DEFAULT_OPTS)
  }

  onConnect(abort) {
    assert(!this.#pos)

    this.#contentMD5 = null
    this.#contentLength = null
    this.#hasher = null
    this.#pos = 0
    this.#errorSent = false

    this.#handler.onConnect(abort)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    this.#contentMD5 = this.#verifyOpts.hash ? headers['content-md5'] : null
    this.#contentLength = this.#verifyOpts.hash ? headers['content-length'] : null
    this.#hasher = this.#contentMD5 != null ? crypto.createHash('md5') : null

    return this.#handler.onHeaders(statusCode, null, resume, statusMessage, headers)
  }

  onData(chunk) {
    this.#pos += chunk.length
    this.#hasher?.update(chunk)

    return this.#handler.onData(chunk)
  }

  onComplete() {
    const contentMD5 = this.#hasher?.digest('base64')

    if (this.#contentLength != null && this.#pos !== Number(this.#contentLength)) {
      this.#errorSent = true
      this.#handler.onError(
        Object.assign(new Error('Request Content-Length mismatch'), {
          expected: Number(this.#contentLength),
          actual: this.#pos,
        }),
      )
    } else if (this.#contentMD5 != null && contentMD5 !== this.#contentMD5) {
      this.#errorSent = true
      this.#handler.onError(
        Object.assign(new Error('Request Content-MD5 mismatch'), {
          expected: this.#contentMD5,
          actual: contentMD5,
        }),
      )
    } else {
      return this.#handler.onComplete()
    }
  }

  onError(err) {
    if (!this.#errorSent) {
      this.#errorSent = true
      this.#handler.onError(err)
    }
  }
}

export default () => (dispatch) => (opts, handler) =>
  !opts.upgrade && opts.verify !== false && opts.method !== 'HEAD'
    ? dispatch(opts, new Handler(opts, { handler }))
    : dispatch(opts, handler)
