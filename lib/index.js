import assert from 'node:assert'
import stream from 'node:stream'
import createError from 'http-errors'
import undici from 'undici'
import { parseHeaders, AbortError } from './utils.js'
import CacheableLookup from 'cacheable-lookup'

const dispatcherCache = new WeakMap()

// https://github.com/fastify/fastify/blob/main/lib/reqIdGenFactory.js
// 2,147,483,647 (2^31 − 1) stands for max SMI value (an internal optimization of V8).
// With this upper bound, if you'll be generating 1k ids/sec, you're going to hit it in ~25 days.
// This is very likely to happen in real-world applications, hence the limit is enforced.
// Growing beyond this value will make the id generation slower and cause a deopt.
// In the worst cases, it will become a float, losing accuracy.
const maxInt = 2147483647
let nextReqId = Math.floor(Math.random() * maxInt)
function genReqId() {
  nextReqId = (nextReqId + 1) & maxInt
  return `req-${nextReqId.toString(36)}`
}

const kAbort = Symbol('abort')
const kStatusCode = Symbol('statusCode')
const kStatusMessage = Symbol('statusMessage')
const kHeaders = Symbol('headers')
const kSize = Symbol('size')

let ABORT_ERROR

class Readable extends stream.Readable {
  constructor({ statusCode, statusMessage, headers, size, abort, highWaterMark, resume }) {
    super(highWaterMark ? { highWaterMark } : undefined)

    this[kStatusCode] = statusCode
    this[kStatusMessage] = statusMessage
    this[kHeaders] = headers
    this[kSize] = size
    this[kAbort] = abort

    this._read = resume
  }

  get statusCode() {
    return this[kStatusCode]
  }

  get statusMessage() {
    return this[kStatusMessage]
  }

  get headers() {
    return this[kHeaders]
  }

  get size() {
    return this[kSize]
  }

  get body() {
    return this
  }

  _destroy(err, callback) {
    if (err == null && !this.readableEnded) {
      ABORT_ERROR ??= new AbortError()
      err = ABORT_ERROR
    }

    if (err) {
      this[kAbort](err)
    }

    callback(err)
  }

  async text() {
    const dec = new TextDecoder()
    let str = ''
    for await (const chunk of this) {
      if (typeof chunk === 'string') {
        str += chunk
      } else {
        str += dec.decode(chunk, { stream: true })
      }
    }
    // Flush the streaming TextDecoder so that any pending
    // incomplete multibyte characters are handled.
    str += dec.decode(undefined, { stream: false })
    return str
  }

  async json() {
    return JSON.parse(await this.text())
  }

  async arrayBuffer() {
    return (await this.buffer()).buffer
  }

  async buffer() {
    const buffers = []
    for await (const chunk of this) {
      buffers.push(chunk)
    }
    return Buffer.concat(buffers)
  }

  dump() {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(null)
      } else {
        let n = 0
        this.on('close', () => resolve(null))
          .on('error', () => {})
          .on('data', (chunk) => {
            n += chunk.length
            if (n > 128 * 1024) {
              this.destroy()
            }
          })
          .resume()
      }
    })
  }
}

const dispatchers = {
  requestBody: (await import('./interceptor/request-body.js')).default,
  requestBodyFactory: (await import('./interceptor/request-body-factory.js')).default,
  abort: (await import('./interceptor/abort.js')).default,
  catch: (await import('./interceptor/catch.js')).default,
  responseContent: (await import('./interceptor/response-content.js')).default,
  requestContent: (await import('./interceptor/request-content.js')).default,
  log: (await import('./interceptor/log.js')).default,
  redirect: (await import('./interceptor/redirect.js')).default,
  responseBodyRetry: (await import('./interceptor/response-body-retry.js')).default,
  responseStatusRetry: (await import('./interceptor/response-status-retry.js')).default,
  responseRetry: (await import('./interceptor/response-retry.js')).default,
  signal: (await import('./interceptor/signal.js')).default,
  proxy: (await import('./interceptor/proxy.js')).default,
  cache: (await import('./interceptor/cache.js')).default,
  requestId: (await import('./interceptor/request-id.js')).default,
}

const dnsCache = new CacheableLookup()
const defaultDispatcher = new undici.Agent({
  connect: {
    lookup: dnsCache.lookup,
  },
})

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
  const idempotent = opts.idempotent ?? (method === 'GET' || method === 'HEAD')

  let headers
  if (Array.isArray(opts.headers)) {
    headers = parseHeaders(opts.headers)
  } else if (opts.headers != null) {
    // TODO (fix): Object.values(opts.headers)?
    headers = opts.headers
  }

  const userAgent = opts.userAgent ?? globalThis.userAgent
  if (userAgent && headers?.['user-agent'] !== userAgent) {
    headers = { 'user-agent': userAgent, ...headers }
  }

  if (method === 'CONNECT') {
    throw new createError.MethodNotAllowed()
  }

  if (
    headers != null &&
    (method === 'HEAD' || method === 'GET') &&
    (parseInt(headers['content-length']) > 0 || headers['transfer-encoding'])
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
    headers = { ...headers }
    delete headers['content-length']
  }

  const dispatcher = opts.dispatcher ?? defaultDispatcher

  let dispatch = dispatcherCache.get(dispatcher)
  if (dispatch == null) {
    dispatch = (opts, handler) => dispatcher.dispatch(opts, handler)
    dispatch = dispatchers.catch(dispatch)
    dispatch = dispatchers.requestBodyFactory(dispatch)
    dispatch = dispatchers.abort(dispatch)
    dispatch = dispatchers.requestId(dispatch)
    dispatch = dispatchers.log(dispatch)
    dispatch = dispatchers.responseRetry(dispatch)
    dispatch = dispatchers.responseStatusRetry(dispatch)
    dispatch = dispatchers.responseBodyRetry(dispatch)
    dispatch = dispatchers.responseContent(dispatch)
    dispatch = dispatchers.requestContent(dispatch)
    dispatch = dispatchers.redirect(dispatch)
    dispatch = dispatchers.signal(dispatch)
    dispatch = dispatchers.cache(dispatch)
    dispatch = dispatchers.proxy(dispatch)
    dispatch = dispatchers.requestBody(dispatch)
    dispatcherCache.set(dispatcher, dispatch)
  }

  return new Promise((resolve, reject) =>
    dispatch(
      {
        id: opts.id ?? headers?.['request-id'] ?? headers?.['Request-Id'] ?? genReqId(),
        url,
        method,
        body: opts.body,
        headers,
        origin: url.origin,
        path: url.path ?? (url.search ? `${url.pathname}${url.search ?? ''}` : url.pathname),
        query: opts.query,
        reset: opts.reset ?? false,
        blocking: opts.blocking ?? false,
        headersTimeout: opts.headersTimeout,
        bodyTimeout: opts.bodyTimeout,
        idempotent,
        signal: opts.signal,
        retry: opts.retry ?? 8,
        proxy: opts.proxy,
        cache: opts.cache,
        upgrade: opts.upgrade,
        follow: opts.follow ?? 8,
        logger: opts.logger,
        highWaterMark: opts.highWaterMark ?? 128 * 1024,
      },
      {
        resolve,
        reject,
        logger: opts.logger,
        /** @type {Function | null} */ abort: null,
        /** @type {stream.Readable | null} */ body: null,
        onConnect(abort) {
          this.abort = abort
        },
        onUpgrade(statusCode, rawHeaders, socket) {
          const headers = parseHeaders(rawHeaders)

          if (statusCode !== 101) {
            this.abort(createError(statusCode, { headers }))
          } else {
            this.resolve({ headers, socket })
          }
        },
        onBodySent(chunk) {},
        onRequestSent() {},
        onHeaders(statusCode, rawHeaders, resume, statusMessage) {
          const headers = parseHeaders(rawHeaders)

          if (statusCode >= 400) {
            this.abort(createError(statusCode, { headers }))
          } else {
            assert(statusCode >= 200)

            const contentLength = Number(headers['content-length'] ?? headers['Content-Length'])

            this.body = new Readable({
              resume,
              abort: this.abort,
              highWaterMark: this.highWaterMark,
              statusCode,
              statusMessage,
              headers,
              size: Number.isFinite(contentLength) ? contentLength : null,
            })

            this.resolve(this.body)
            this.resolve = null
            this.reject = null
          }

          return false
        },
        onData(chunk) {
          return this.body.push(chunk)
        },
        onComplete() {
          this.body.push(null)
        },
        onError(err) {
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
