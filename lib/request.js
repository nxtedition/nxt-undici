import assert from 'node:assert'
import { InvalidArgumentError, RequestAbortedError } from './errors.js'
import { isStream, parseHeaders } from './utils.js'
import { BodyReadable as Readable } from './readable.js'

function noop() {}

export class RequestHandler {
  constructor(opts, callback) {
    if (!opts || typeof opts !== 'object') {
      throw new InvalidArgumentError('invalid opts')
    }

    const { signal, method, body, highWaterMark } = opts

    try {
      if (typeof callback !== 'function') {
        throw new InvalidArgumentError('invalid callback')
      }

      if (highWaterMark && (typeof highWaterMark !== 'number' || highWaterMark < 0)) {
        throw new InvalidArgumentError('invalid highWaterMark')
      }

      if (
        signal &&
        typeof signal.on !== 'function' &&
        typeof signal.addEventListener !== 'function'
      ) {
        throw new InvalidArgumentError('signal must be an EventEmitter or EventTarget')
      }

      if (method === 'CONNECT') {
        throw new InvalidArgumentError('invalid method')
      }
    } catch (err) {
      if (isStream(body)) {
        body.on('error', noop).destroy(err)
      }
      throw err
    }

    this.method = method
    this.callback = callback
    this.res = null
    this.abort = null
    this.body = body
    this.context = null
    this.highWaterMark = highWaterMark
    this.reason = null

    if (signal?.aborted) {
      this.reason = signal.reason ?? new RequestAbortedError()
    } else if (signal) {
      const onAbort = () => {
        this.reason = signal.reason ?? new RequestAbortedError()
        if (this.res) {
          this.res.on('error', noop).destroy(this.reason)
        } else if (this.abort) {
          this.abort(this.reason)
        }
      }
      signal.addEventListener('abort', onAbort)
      this.removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    }
  }

  onConnect(abort) {
    if (this.reason) {
      abort(this.reason)
      return
    }

    assert(this.callback)

    this.abort = abort
  }

  onHeaders(statusCode, rawHeaders, resume, headers = parseHeaders(rawHeaders)) {
    const { callback, abort, highWaterMark } = this

    if (statusCode < 200) {
      return true
    }

    const contentType = headers['content-type']
    const contentLength = headers['content-length']
    const res = new Readable({
      resume,
      abort,
      contentType: typeof contentType === 'string' ? contentType : undefined,
      contentLength: this.method !== 'HEAD' && contentLength ? Number(contentLength) : undefined,
      highWaterMark,
    })

    if (this.removeAbortListener) {
      res.on('close', this.removeAbortListener)
      this.removeAbortListener = undefined
    }

    this.callback = null
    this.res = res

    if (callback !== null) {
      callback(null, { statusCode, headers, body: res })
    }
  }

  onData(chunk) {
    return this.res?.push(chunk)
  }

  onComplete() {
    this.res?.push(null)
  }

  onError(err) {
    const { res, callback, body } = this

    if (callback) {
      // TODO: Does this need queueMicrotask?
      this.callback = null
      queueMicrotask(() => {
        callback(err)
      })
    }

    if (res) {
      this.res = null
      // Ensure all queued handlers are invoked before destroying res.
      queueMicrotask(() => {
        res.on('error', noop).destroy(err)
      })
    }

    if (body) {
      this.body = null

      if (isStream(body)) {
        body.on('error', noop).destroy(err)
      }
    }

    if (this.removeAbortListener) {
      this.removeAbortListener()
      this.removeAbortListener = undefined
    }
  }
}

export function request(dispatch, url, opts) {
  return new Promise((resolve, reject) => {
    if (typeof url === 'string') {
      opts = { url: new URL(url), ...opts }
    } else if (url instanceof URL) {
      opts = { url, ...opts }
    } else if (typeof url.origin === 'string' && typeof (url.path ?? url.pathname) === 'string') {
      opts = opts ? { ...url, ...opts } : url
    }

    if (opts == null && typeof url === 'object' && url != null) {
      opts = url
    }

    dispatch(
      opts,
      new RequestHandler(opts, (err, res) => {
        if (err) {
          reject(err)
        } else {
          resolve(res)
        }
      }),
    )
  })
}
