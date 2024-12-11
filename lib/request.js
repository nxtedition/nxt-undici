import assert from 'node:assert'
import { InvalidArgumentError, RequestAbortedError } from './errors.js'
import { isStream, parseHeaders } from './utils.js'
import { BodyReadable as Readable } from './readable.js'

function noop() {}

export class RequestHandler {
  constructor({ signal, method, body, highWaterMark }, resolve) {
    try {
      if (typeof resolve !== 'function') {
        throw new InvalidArgumentError('invalid resolve')
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
    this.resolve = resolve
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

    assert(this.resolve)

    this.abort = abort
  }

  onHeaders(statusCode, rawHeaders, resume, headers = parseHeaders(rawHeaders)) {
    const { resolve, abort, highWaterMark } = this

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

    this.resolve = null
    this.res = res

    if (resolve !== null) {
      resolve({ statusCode, headers, body: res })
    }
  }

  onData(chunk) {
    return this.res?.push(chunk)
  }

  onComplete() {
    this.res?.push(null)
  }

  onError(err) {
    const { res, resolve, body } = this

    if (resolve) {
      // TODO: Does this need queueMicrotask?
      this.resolve = null
      queueMicrotask(() => {
        resolve(Promise.reject(err))
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
  if (!url || (typeof url !== 'string' && typeof url !== 'object' && !(url instanceof URL))) {
    throw new InvalidArgumentError('invalid url')
  }

  if (opts != null && typeof opts !== 'object') {
    throw new InvalidArgumentError('invalid opts')
  }

  if (typeof url === 'string') {
    url = new URL(url)
  } else if (typeof url === 'object' && url != null && opts == null) {
    opts = url
  }

  let origin = url.origin

  if (!origin) {
    const protocol = url.protocol ?? 'http:'
    const host = url.host ?? `${url.hostname}:${url.port ?? (protocol === 'https:' ? 443 : 80)}`
    origin = `${protocol}//${host}`
  }

  let path = url.path
  if (!path) {
    path = url.search ? `${url.pathname}${url.search}` : url
  }

  opts = { ...opts, origin, path }

  return new Promise((resolve) => dispatch(opts, new RequestHandler(opts, resolve)))
}
