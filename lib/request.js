import assert from 'node:assert'
import { addAbortListener } from 'node:events'
import { types } from 'node:util'
import { errors, Readable } from '@nxtedition/undici'
import { buildAuthority, isHttpProtocol, isStream, validateAuthority } from './utils.js'

const { InvalidArgumentError, RequestAbortedError } = errors

function noop() {}

function streamError(reason) {
  return reason != null && !types.isNativeError(reason)
    ? new Error('Request failed during stream cleanup', { cause: reason })
    : reason
}

function tryAddAbortListener(signal, listener) {
  try {
    return addAbortListener(signal, listener)
  } catch (err) {
    if (err?.code !== 'ERR_INVALID_ARG_TYPE') {
      throw err
    }
    return null
  }
}

function getEmitterRemoval(signal) {
  return typeof signal.removeListener === 'function' ? signal.removeListener : signal.off
}

function isAbortEventTarget(signal) {
  return (
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
  )
}

function isAbortEventEmitter(signal) {
  return typeof signal.on === 'function' && typeof getEmitterRemoval(signal) === 'function'
}

export class RequestHandler {
  constructor({ signal, method, body, highWaterMark }, resolve) {
    if (isStream(body) && body.closed) {
      body = null
    }

    try {
      if (typeof resolve !== 'function') {
        throw new InvalidArgumentError('invalid resolve')
      }

      // Match Node and @nxtedition/undici streams: highWaterMark must be a
      // non-negative integer, but it is not restricted to safe integers.
      if (highWaterMark != null && (!Number.isInteger(highWaterMark) || highWaterMark < 0)) {
        throw new InvalidArgumentError('invalid highWaterMark')
      }

      if (signal && !isAbortEventTarget(signal) && !isAbortEventEmitter(signal)) {
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
    this.aborted = false
    this.reason = null

    if (signal?.aborted) {
      this.aborted = true
      this.reason = signal.reason === undefined ? new RequestAbortedError() : signal.reason
    } else if (signal) {
      const onAbort = () => {
        this.aborted = true
        this.reason = signal.reason === undefined ? new RequestAbortedError() : signal.reason
        if (this.res) {
          this.res.on('error', noop).destroy(streamError(this.reason))
        } else {
          // The currently installed abort can be only an eager interceptor
          // bridge (redirect registers one before the transport connects), so
          // invoking it does not guarantee a terminal onError. Give it the
          // chance to cancel a connected transport, then settle the public
          // promise ourselves if the handler is still waiting for headers.
          this.abort?.(this.reason)
          if (this.resolve) {
            this.onError(this.reason)
          }
        }
      }
      // Let Node recognize native AbortSignals so cross-realm instances get a
      // propagation-resistant listener. Generic EventTargets and EventEmitters
      // retain their compatibility paths.
      if (isAbortEventTarget(signal)) {
        const disposable = tryAddAbortListener(signal, onAbort)
        if (disposable) {
          this.removeAbortListener = () => disposable[Symbol.dispose]()
        } else {
          signal.addEventListener('abort', onAbort)
          this.removeAbortListener = () => signal.removeEventListener('abort', onAbort)
        }
      } else {
        const removeEmitterListener = getEmitterRemoval(signal)
        signal.on('abort', onAbort)
        this.removeAbortListener = () => removeEmitterListener.call(signal, 'abort', onAbort)
      }
    }
  }

  onConnect(abort) {
    if (this.aborted) {
      abort(this.reason)
      return
    }

    assert(this.resolve)

    this.abort = abort
  }

  onHeaders(statusCode, headers, resume) {
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
    const cleanupError = streamError(err)

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
        res.on('error', noop).destroy(cleanupError)
      })
    }

    if (body) {
      this.body = null

      if (isStream(body)) {
        body.on('error', noop).destroy(cleanupError)
      }
    }

    if (this.removeAbortListener) {
      this.removeAbortListener()
      this.removeAbortListener = undefined
    }
  }
}

export function request(dispatch, urlOrOpts, optsOrNully) {
  let url = urlOrOpts
  let opts = optsOrNully

  if (typeof url === 'object' && url != null) {
    if (opts == null) {
      // Single-arg form: the object is both the url source and the opts.
      opts = url
      url = url.url ?? url
    } else if (url.url != null) {
      // Two-arg object-first form, e.g. request({ url }, { dispatcher }):
      // unwrap the url field but keep the separately-provided opts. A genuine
      // WHATWG URL has no `.url` property, so real URL objects are unaffected.
      url = url.url
    }
  }

  if (typeof url === 'string') {
    url = new URL(url)
  }

  if (url == null || typeof url !== 'object') {
    throw new InvalidArgumentError('invalid url')
  }

  if (opts != null && typeof opts !== 'object') {
    throw new InvalidArgumentError('invalid opts')
  }

  let origin = url.origin
  if (!origin) {
    const protocol = url.protocol ?? 'http:'
    if (!isHttpProtocol(protocol)) {
      throw new InvalidArgumentError('invalid url')
    }
    let host
    try {
      host = url.host
        ? validateAuthority(protocol, url.host)
        : url.hostname
          ? buildAuthority(protocol, url.hostname, url.port)
          : null
    } catch {
      throw new InvalidArgumentError('invalid url')
    }

    if (!host || !protocol) {
      throw new InvalidArgumentError('invalid url')
    }

    origin = `${protocol}//${host}`
  }

  let path = url.path
  if (!path) {
    // URLObject marks every field optional; default the path so e.g.
    // request({ origin }) works instead of undici rejecting with
    // "path must be a string".
    const pathname = url.pathname || '/'
    path = url.search ? `${pathname}${url.search}` : pathname
  }

  opts = {
    ...opts,
    origin,
    path,
    body: isStream(opts?.body) && opts.body.closed ? null : opts?.body,
  }

  return new Promise((resolve) => {
    const handler = new RequestHandler(opts, resolve)
    if (handler.aborted) {
      // Do not enqueue work for a signal that was already aborted. Route the
      // reason through the regular terminal path so bodies and listeners are
      // cleaned up exactly as they are for an in-flight failure.
      handler.onError(handler.reason)
      return
    }
    try {
      const result = dispatch(opts, handler)
      if (result != null && typeof result.then === 'function') {
        void Promise.resolve(result).catch((err) => handler.onError(err))
      }
    } catch (err) {
      // A synchronous throw from dispatch otherwise skips onConnect/onError, so
      // the request body stream is never destroyed and the signal's abort
      // listener is never removed — both leak. Route it through onError, whose
      // idempotent guards make this harmless if dispatch already reported.
      handler.onError(err)
    }
  })
}
