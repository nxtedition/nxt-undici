import assert from 'node:assert'
import createError from 'http-errors'
import undici from 'undici'
import { parseHeaders, AbortError, isStream } from './utils.js'
import { BodyReadable } from './readable.js'

const dispatcherCache = new WeakMap()

export const interceptors = {
  requestBodyFactory: (await import('./interceptor/request-body-factory.js')).default,
  responseError: (await import('./interceptor/response-error.js')).default,
  responseRetry: (await import('./interceptor/response-retry.js')).default,
  responseVerify: (await import('./interceptor/response-verify.js')).default,
  log: (await import('./interceptor/log.js')).default,
  redirect: (await import('./interceptor/redirect.js')).default,
  proxy: (await import('./interceptor/proxy.js')).default,
  cache: (await import('./interceptor/cache.js')).default,
  requestId: (await import('./interceptor/request-id.js')).default,
}

export async function request(url, opts) {
  // TODO (fix): More argument validation...

  if (typeof url === 'string') {
    url = new URL(url)
  } else if (url instanceof URL) {
    // Do nothing...
  } else if (typeof url.origin === 'string' && typeof (url.path ?? url.pathname) === 'string') {
    // Do nothing...
  }

  if (opts == null && typeof url === 'object' && url != null) {
    opts = url
  }

  if (url) {
    // Do nothing...
  } else if (typeof opts.url === 'string') {
    url = new URL(opts.url)
  } else if (url.url instanceof URL) {
    url = opts.url
  } else if (typeof opts.origin === 'string' && typeof (opts.path ?? opts.pathname) === 'string') {
    url = opts
  } else {
    throw new Error('missing url')
  }

  const method = opts.method ?? (opts.body ? 'POST' : 'GET')
  const headers = parseHeaders(opts.headers)

  const userAgent = opts.userAgent ?? globalThis.userAgent
  if (userAgent && headers?.['user-agent'] !== userAgent) {
    headers['user-agent'] = userAgent
  }

  if (method === 'CONNECT') {
    throw new createError.MethodNotAllowed()
  }

  // TODO (fix): Move into undici?
  if (
    headers != null &&
    (method === 'HEAD' || method === 'GET') &&
    (parseInt(headers['content-length']) > 0 || headers['transfer-encoding'])
  ) {
    throw new createError.BadRequest('HEAD and GET cannot have body')
  }

  // TODO (fix): Move into undici?
  if (
    opts.body != null &&
    (opts.body.size > 0 || opts.body.length > 0) &&
    (method === 'HEAD' || method === 'GET')
  ) {
    throw new createError.BadRequest('HEAD and GET cannot have body')
  }

  const expectsPayload = opts.method === 'PUT' || opts.method === 'POST' || opts.method === 'PATCH'

  if (headers != null && headers['content-length'] === '0' && !expectsPayload) {
    // https://tools.ietf.org/html/rfc7230#section-3.3.2
    // A user agent SHOULD NOT send a Content-Length header field when
    // the request message does not contain a payload body and the method
    // semantics do not anticipate such a body.

    // undici will error if provided an unexpected content-length: 0 header.
    delete headers['content-length']
  }

  if (isStream(opts.body)) {
    // TODO (fix): Remove this somehow?
    // Workaround: https://github.com/nodejs/undici/pull/2497
    opts.body.on('error', () => {})
  }

  const dispatcher = opts.dispatcher ?? undici.getGlobalDispatcher()

  let dispatch = dispatcherCache.get(dispatcher)
  if (dispatch == null) {
    dispatch = (opts, handler) => dispatcher.dispatch(opts, handler)
    dispatch = interceptors.responseError(dispatch)
    dispatch = interceptors.requestBodyFactory(dispatch)
    dispatch = interceptors.log(dispatch)
    dispatch = interceptors.requestId(dispatch)
    dispatch = interceptors.responseRetry(dispatch)
    dispatch = interceptors.responseVerify(dispatch)
    dispatch = interceptors.cache(dispatch)
    dispatch = interceptors.redirect(dispatch)
    dispatch = interceptors.proxy(dispatch)
    dispatcherCache.set(dispatcher, dispatch)
  }

  return await new Promise((resolve, reject) =>
    dispatch(
      {
        id: opts.id,
        url,
        method,
        body: opts.body,
        query: opts.query,
        headers,
        origin: url.origin,
        path: url.path ?? (url.search ? `${url.pathname}${url.search ?? ''}` : url.pathname),
        reset: opts.reset ?? false,
        blocking: opts.blocking ?? false,
        headersTimeout: opts.headersTimeout,
        bodyTimeout: opts.bodyTimeout,
        idempotent: opts.idempotent,
        retry: opts.retry ?? 8,
        proxy: opts.proxy ?? false,
        cache: opts.cache ?? true,
        upgrade: opts.upgrade ?? false,
        follow: opts.follow ?? 8,
        error: opts.error ?? true,
        verify: opts.verify ?? true,
        logger: opts.logger ?? null,
      },
      {
        resolve,
        reject,
        method,
        highWaterMark: opts.highWaterMark ?? 128 * 1024,
        logger: opts.logger,
        signal: opts.signal,
        /** @type {Function | null} */ abort: null,
        /** @type {stream.Readable | null} */ body: null,
        onConnect(abort) {
          if (this.signal?.aborted) {
            abort(this.signal.reason)
          } else {
            this.abort = abort

            if (this.signal) {
              this.onAbort = () => {
                if (this.body) {
                  this.body.destroy(this.signal.reason ?? new AbortError())
                } else {
                  this.abort(this.signal.reason)
                }
              }
              this.signal.addEventListener('abort', this.onAbort)
            }
          }
        },
        onUpgrade(statusCode, rawHeaders, socket, headers = parseHeaders(rawHeaders)) {
          if (statusCode !== 101) {
            this.abort(createError(statusCode, { headers }))
          } else {
            this.resolve({ headers, socket })
            this.resolve = null
          }
        },
        onHeaders(
          statusCode,
          rawHeaders,
          resume,
          statusMessage,
          headers = parseHeaders(rawHeaders),
        ) {
          assert(statusCode >= 200)

          const contentLength = headers['content-length']
          const contentType = headers['content-type']

          this.body = new BodyReadable(this, {
            resume,
            abort: this.abort,
            highWaterMark: this.highWaterMark,
            method: this.method,
            statusCode,
            statusMessage,
            contentType,
            headers,
            size: Number.isFinite(contentLength) ? contentLength : null,
          })

          if (this.signal) {
            this.body.on('close', () => {
              this.signal?.removeEventListener('abort', this.onAbort)
              this.signal = null
            })
          }

          this.resolve(this.body)
          this.resolve = null
          this.reject = null

          return true
        },
        onData(chunk) {
          return this.body.push(chunk)
        },
        onComplete() {
          this.body.push(null)
        },
        onError(err) {
          this.signal?.removeEventListener('abort', this.onAbort)
          this.signal = null

          if (this.body) {
            this.body.destroy(err)
          } else {
            this.reject(err)
            this.resolve = null
            this.reject = null
          }
        },
      },
    ),
  )
}
