import crypto from 'node:crypto'
import { DecoratorHandler, parseContentRange } from '../utils.js'
import { traceWrite, traceSafe, traceUrl } from '../trace.js'

// Emit an `undici:verify` trace doc carrying the by-how-much/what-values
// detail of a verification failure, immediately before the error is delivered.
// The undici:request end doc already tags THAT the request failed; this doc is
// for fingerprinting truncation vs corruption. Cold path only — every call
// site is an already-failing branch — so the writer is resolved per emission
// (explicit opts.trace wins, absent falls back to the global) at zero cost on
// the per-chunk hot path. Hash values are origin-influenced strings (a
// duplicated Content-MD5 header keeps `expected` as an array of conflicting
// values, which String() flattens), so bound them.
function traceVerify(opts, kind, expectedSize, actualSize, expectedHash, actualHash) {
  const write = traceWrite(opts.trace)
  if (write !== null) {
    traceSafe(
      write,
      {
        id: opts.id ?? null,
        method: opts.method ?? null,
        url: traceUrl(opts),
        kind,
        expectedSize,
        actualSize,
        expectedHash: expectedHash != null ? String(expectedHash).slice(0, 64) : null,
        actualHash: actualHash != null ? String(actualHash).slice(0, 64) : null,
      },
      'undici:verify',
    )
  }
}

class Handler extends DecoratorHandler {
  #opts
  #verifyOpts
  #contentMD5
  #expectedSize
  #hasher
  #pos = 0
  #abort

  constructor(opts, { handler }) {
    super(handler)

    // Retained only for failure-time trace tagging (id/method/url).
    this.#opts = opts
    this.#verifyOpts = opts.verify === true ? { hash: true, size: true } : opts.verify
  }

  onConnect(abort) {
    this.#contentMD5 = null
    this.#expectedSize = null
    this.#hasher = null
    this.#pos = 0
    // Keep the raw transport abort so a mid-stream verification failure can
    // tear down the connection. The DecoratorHandler-wrapped abort becomes a
    // no-op once super.onError sets #errored, so we must drive abort directly.
    this.#abort = abort

    super.onConnect(abort)
  }

  onHeaders(statusCode, headers, resume) {
    // Responses that by definition carry no body — 1xx informational, 204 No
    // Content, 205 Reset Content, 304 Not Modified — must not be size/hash-
    // verified. A 304 in particular may echo the Content-Length of the full
    // representation it refers to; verifying the (absent) body against it would
    // falsely trip the size check and break conditional-request revalidation.
    // Leaving #expectedSize/#hasher null makes onData/onComplete no-ops here.
    if (statusCode < 200 || statusCode === 204 || statusCode === 205 || statusCode === 304) {
      return super.onHeaders(statusCode, headers, resume)
    }

    // A duplicated Content-MD5 header arrives as an array. Several identical
    // copies (a CDN/proxy re-appending its own) describe the same digest, so
    // collapse them to one; genuinely conflicting copies are kept as an array
    // so the strict comparison in onComplete still fails. A non-array (the
    // common single-header case) is used verbatim.
    const md5 = this.#verifyOpts.hash ? headers['content-md5'] : null
    this.#contentMD5 = Array.isArray(md5) && md5.every((v) => v === md5[0]) ? md5[0] : md5

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
      const err = Object.assign(new Error('Response body exceeded Content-Range'), {
        expected: this.#expectedSize,
        actual: this.#pos,
      })
      traceVerify(this.#opts, 'overrun', this.#expectedSize, this.#pos, null, null)
      super.onError(err)
      // Returning false only applies backpressure; the socket would stay
      // paused until bodyTimeout. Abort to release the connection now.
      this.#abort?.(err)
      return false
    }

    return super.onData(chunk)
  }

  onComplete(trailers) {
    const contentMD5 = this.#hasher?.digest('base64')

    if (this.#expectedSize != null && this.#pos !== this.#expectedSize) {
      traceVerify(this.#opts, 'size', this.#expectedSize, this.#pos, null, null)
      super.onError(
        Object.assign(new Error('Response body size mismatch'), {
          expected: this.#expectedSize,
          actual: this.#pos,
        }),
      )
    } else if (this.#contentMD5 != null && contentMD5 !== this.#contentMD5) {
      traceVerify(this.#opts, 'hash', null, null, this.#contentMD5, contentMD5)
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
