import { DecoratorHandler, decorateError } from '../utils.js'

const MAX_ERROR_BODY_SIZE = 256 * 1024

class Handler extends DecoratorHandler {
  #statusCode = 0
  #decoder
  #headers
  #trailers
  #body = ''
  #bodySize = 0
  #opts
  #reason = null

  constructor(opts, { handler }) {
    super(handler)

    this.#opts = opts
  }

  onConnect(abort) {
    this.#statusCode = 0
    this.#decoder = null
    this.#headers = null
    this.#trailers = null
    this.#body = ''
    this.#bodySize = 0
    this.#reason = null

    super.onConnect((reason) => {
      // Remember the abort reason so onError can recognize it. The reason is
      // owned by the caller (e.g. signal.reason) and must not be decorated.
      this.#reason = reason ?? null
      abort(reason)
    })
  }

  onHeaders(statusCode, headers, resume) {
    this.#statusCode = statusCode
    this.#headers = headers

    if (this.#statusCode < 400) {
      return super.onHeaders(statusCode, headers, resume)
    }

    // A duplicated content-type header is an array; .startsWith would throw
    // synchronously out of this parser callback. Coerce to the first value.
    const contentType = Array.isArray(this.#headers['content-type'])
      ? this.#headers['content-type'][0]
      : this.#headers['content-type']
    if (contentType?.startsWith('application/json') || contentType?.startsWith('text/plain')) {
      this.#decoder = new TextDecoder('utf-8')
      this.#body = ''
    }

    return true
  }

  onData(chunk) {
    if (this.#statusCode < 400) {
      return super.onData(chunk)
    }

    if (this.#decoder) {
      this.#bodySize += chunk.byteLength
      if (this.#bodySize <= MAX_ERROR_BODY_SIZE) {
        this.#body += this.#decoder.decode(chunk, { stream: true })
      }
    }
  }

  onComplete(trailers) {
    this.#trailers = trailers

    if (this.#statusCode < 400) {
      return super.onComplete(trailers)
    }

    this.#body += this.#decoder?.decode(undefined, { stream: false }) ?? ''

    super.onError(
      decorateError(null, this.#opts, {
        statusCode: this.#statusCode || undefined,
        headers: this.#headers,
        trailers: this.#trailers,
        body: this.#body,
      }),
    )
  }

  onError(err) {
    // An abort reason is owned by the caller and may be shared by every
    // request in flight on the same signal — decorating it in place would
    // permanently mutate the caller's object and leak one request's req/res
    // onto another request's rejection (last writer wins). Callers also rely
    // on receiving the exact reason object, so pass it through untouched.
    if (err != null && (err === this.#reason || err === this.#opts.signal?.reason)) {
      super.onError(err)
      return
    }

    // An inner response interceptor may already have decorated the error with
    // metadata for a response that this outer handler never saw (for example,
    // the failed range-resume attempt hidden by response-retry). Keep that
    // response as a unit instead of replacing it with stale captured metadata.
    if (err?.res != null && typeof err.res === 'object') {
      err.statusCode ??= err.res.statusCode
      err.req ??= {
        path: this.#opts.path,
        origin: this.#opts.origin,
        method: this.#opts.method,
        headers: this.#opts.headers,
      }
      super.onError(err)
      return
    }

    // An inner response decorator can know more than this outer handler. In
    // particular, response-retry hides a failed body-resume response's headers
    // after the original response headers have already been exposed, and puts
    // the resume attempt's status on the terminal error. Do not overwrite that
    // current status with the earlier response status observed here, or pair
    // that status with headers/trailers from the earlier response.
    const hasDifferentStatus = err?.statusCode != null && err.statusCode !== this.#statusCode

    super.onError(
      decorateError(err, this.#opts, {
        statusCode: err?.statusCode ?? (this.#statusCode || undefined),
        headers: hasDifferentStatus ? null : this.#headers,
        trailers: hasDifferentStatus ? null : this.#trailers,
        body: null,
      }),
    )
  }
}

export default () => (dispatch) => (opts, handler) =>
  opts.throwOnError !== false && opts.error !== false
    ? dispatch(opts, new Handler(opts, { handler }))
    : dispatch(opts, handler)
