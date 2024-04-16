import assert from 'node:assert'
import { isDisturbed, retry as retryFn } from '../utils.js'
import { DecoratorHandler } from 'undici'

class Handler extends DecoratorHandler {
  #handler

  #dispatch
  #abort
  #opts
  #resume

  #headersSent = false
  #errorSent = false

  #retryCount = 0
  #reason
  #aborted = false

  #statusCode
  #rawHeaders
  #headers
  #statusMessage

  constructor(opts, { dispatch, handler }) {
    super(handler)

    this.#dispatch = dispatch
    this.#handler = handler
    this.#opts = opts

    this.#handler.onConnect((reason) => {
      this.#aborted = true
      if (this.#abort) {
        this.#abort(reason)
      } else {
        this.#reason = reason
      }
    })
  }

  onConnect(abort) {
    if (this.#aborted) {
      abort(this.#reason)
    } else {
      this.#abort = abort
    }
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers) {
    assert(this.#headersSent === false)

    this.#statusCode = statusCode
    this.#rawHeaders = rawHeaders
    this.#statusMessage = statusMessage
    this.#headers = headers
    this.#resume = resume

    return true
  }

  onData(chunk) {
    if (!this.#headersSent) {
      this.#sendHeaders()
    }

    return this.#handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    if (!this.#headersSent) {
      this.#sendHeaders()
    }

    return this.#handler.onComplete(rawTrailers)
  }

  onError(err) {
    if (this.#aborted || this.#headersSent || isDisturbed(this.#opts.body)) {
      return this.#onError(err)
    }

    const retryPromise = retryFn(err, this.#retryCount++, this.#opts)
    if (retryPromise == null) {
      return this.#onError(err)
    }

    this.#opts.logger?.debug({ retryCount: this.#retryCount }, 'retrying response')

    retryPromise
      .then(() => {
        if (this.#aborted) {
          // Do nothing...
        } else if (isDisturbed(this.#opts.body)) {
          this.#onError(err)
        } else {
          this.#dispatch(this.#opts, this)
        }
      })
      .catch((err) => {
        if (this.#aborted) {
          // Do nothing...
        } else {
          this.#onError(err)
        }
      })
  }

  #onError(err) {
    assert(!this.#errorSent)
    this.#errorSent = true
    this.#handler.onError(err)
  }

  #sendHeaders() {
    const ret = this.#onHeaders(
      this.#statusCode,
      this.#rawHeaders,
      this.#resume,
      this.#statusMessage,
      this.#headers,
    )

    this.#statusCode = null
    this.#rawHeaders = null
    this.#resume = null
    this.#statusMessage = null
    this.#headers = null

    return ret
  }

  #onHeaders(...args) {
    assert(!this.#headersSent)

    this.#headersSent = true
    return this.#handler.onHeaders(...args)
  }
}

export default (dispatch) => (opts, handler) => {
  return opts.retry
    ? dispatch(opts, new Handler(opts, { handler, dispatch }))
    : dispatch(opts, handler)
}
