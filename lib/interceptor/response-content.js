import crypto from 'node:crypto'
import assert from 'node:assert'
import { parseHeaders } from '../utils.js'
import { DecoratorHandler } from 'undici'

class Handler extends DecoratorHandler {
  #handler

  #contentMD5
  #contentLength
  #hasher
  #pos
  #errored

  constructor(opts, { handler }) {
    super(handler)

    this.#handler = handler
  }

  onConnect(abort) {
    assert(!this.#pos)

    this.#contentMD5 = null
    this.#contentLength = null
    this.#hasher = null
    this.#pos = 0
    this.#errored = false

    this.#handler.onConnect(abort)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    this.#contentMD5 = headers ? headers['content-md5'] : headers['content-md5']
    this.#contentLength = headers ? headers['content-length'] : headers['content-length']
    this.#hasher = this.#contentMD5 != null ? crypto.createHash('md5') : null

    return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
  }

  onData(chunk) {
    this.#pos += chunk.length
    this.#hasher?.update(chunk)

    return this.#handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    const contentMD5 = this.#hasher?.digest('base64')

    if (this.#contentLength != null && this.#pos !== Number(this.#contentLength)) {
      this.#errored = true
      this.#handler.onError(
        Object.assign(new Error('Request Content-Length mismatch'), {
          expected: Number(this.#contentLength),
          actual: this.#pos,
        }),
      )
    } else if (this.#contentMD5 != null && contentMD5 !== this.#contentMD5) {
      this.#errored = true
      this.#handler.onError(
        Object.assign(new Error('Request Content-MD5 mismatch'), {
          expected: this.#contentMD5,
          actual: contentMD5,
        }),
      )
    } else {
      return this.#handler.onComplete(rawTrailers)
    }
  }

  onError(err) {
    if (this.#errored) {
      // Do nothing...
    } else {
      this.#handler.onError(err)
    }
  }
}

export default (dispatch) => (opts, handler) =>
  !opts.upgrade ? dispatch(opts, new Handler(opts, { handler })) : dispatch(opts, handler)
