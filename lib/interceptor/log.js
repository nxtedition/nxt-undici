import { DecoratorHandler } from '../utils.js'

const kGlobalIndex = Symbol.for('@nxtedition/nxt-undici#globalIndex')
const kGlobalArray = Symbol.for('@nxtedition/nxt-undici#globalArray')

const REDACTED = '[redacted]'

// Header names (lowercase) whose values must never reach the logs.
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie'])

// Build a plain, lowercase-keyed copy of `headers` with credential values
// replaced by a redaction marker. Accepts both the object form used by the
// request pipeline and the raw flat-array form ([name, value, name, value, ...]
// with Buffer or string entries) that undici hands to onHeaders/onUpgrade.
function sanitizeHeaders(headers) {
  if (headers == null || typeof headers !== 'object') {
    return undefined
  }

  const sanitized = {}

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length - 1; i += 2) {
      const name = String(headers[i]).toLowerCase()
      if (SECRET_HEADERS.has(name)) {
        sanitized[name] = REDACTED
      } else {
        const value = headers[i + 1]
        sanitized[name] = Array.isArray(value) ? value.map(String) : String(value)
      }
    }
  } else {
    for (const key of Object.keys(headers)) {
      const name = key.toLowerCase()
      sanitized[name] = SECRET_HEADERS.has(name) ? REDACTED : headers[key]
    }
  }

  return sanitized
}

// Summarize the request body (type + size) instead of embedding its content.
// Bodies may contain credentials or be arbitrarily large, and pino serializes
// child bindings eagerly — never put the payload itself into the log record.
function describeBody(body) {
  if (body == null) {
    return undefined
  }
  if (typeof body === 'string') {
    return `string(${Buffer.byteLength(body)} bytes)`
  }
  if (ArrayBuffer.isView(body)) {
    return `${body.constructor?.name ?? 'Buffer'}(${body.byteLength} bytes)`
  }
  if (typeof body === 'object' && typeof body.byteLength === 'number') {
    return `${body.constructor?.name ?? 'ArrayBuffer'}(${body.byteLength} bytes)`
  }
  if (typeof body === 'function') {
    return 'function'
  }
  return body.constructor?.name ?? typeof body
}

// Small, sanitized summary of the request opts used for all `ureq` log
// bindings. Built once per request instead of binding the live opts object,
// which both leaked credentials/bodies into logs and paid eager pino
// serialization of the full opts (including the entire body) per request.
function sanitizeRequest(opts) {
  return {
    id: opts.id,
    origin: opts.origin != null ? String(opts.origin) : undefined,
    path: opts.path,
    method: opts.method,
    headers: sanitizeHeaders(opts.headers),
    body: describeBody(opts.body),
  }
}

class Handler extends DecoratorHandler {
  #ureq
  #logger

  #abort
  #aborted = false
  #pos = 0
  #created = performance.now()
  #timing = {
    created: -1,
    connect: -1,
    headers: -1,
    data: -1,
    end: -1,
  }

  #statusCode
  #headers

  constructor(logOpts, opts, { handler }) {
    super(handler)

    this.#ureq = sanitizeRequest(opts)
    this.#logger = opts.logger.child({ ureq: this.#ureq })

    if (logOpts?.bindings) {
      this.#logger = this.#logger.child(logOpts?.bindings)
    }

    this.#logger.debug('upstream request started')
    this.#timing.created = this.#created + performance.timeOrigin

    this[kGlobalArray] = globalThis[kGlobalArray] ??= []
    this[kGlobalIndex] = this[kGlobalArray].push(this) - 1
  }

  onConnect(abort) {
    this.#pos = 0
    this.#abort = abort

    this.#timing.connect = performance.now() - this.#created
    this.#timing.headers = -1
    this.#timing.data = -1
    this.#timing.end = -1

    super.onConnect((reason) => {
      this.#aborted = true
      this.#abort(reason)
    })
  }

  onUpgrade(statusCode, headers, socket) {
    this.#timing.headers = performance.now() - this.#created

    this.#logger.debug(
      {
        ures: { statusCode, headers: sanitizeHeaders(headers) },
        elapsedTime: this.#timing.headers,
      },
      'upstream request upgrade',
    )

    socket.on('close', () => {
      this.#logger.debug('upstream request socket closed')
      this.onDone()
    })

    super.onUpgrade(statusCode, headers, socket)
  }

  onHeaders(statusCode, headers, resume) {
    this.#timing.headers = performance.now() - this.#created
    this.#statusCode = statusCode
    // Only used for log records; store the sanitized copy so set-cookie etc.
    // never end up in retained (error-level) logs.
    this.#headers = sanitizeHeaders(headers)

    return super.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    if (this.#timing.data === -1) {
      this.#timing.data = performance.now() - this.#created
    }

    this.#pos += chunk.length

    return super.onData(chunk)
  }

  onComplete(trailers) {
    this.#timing.end = performance.now() - this.#created

    const data = {
      ureq: this.#ureq,
      ures: {
        statusCode: this.#statusCode,
        headers: this.#headers,
        timing: this.#timing,
        bytesRead: this.#pos,
        bytesReadPerSecond:
          this.#timing.data >= 0 && this.#timing.end > this.#timing.data
            ? (this.#pos * 1e3) / (this.#timing.end - this.#timing.data)
            : 0,
      },
      elapsedTime: this.#timing.end,
    }

    if (this.#statusCode >= 500) {
      this.#logger.error(data, 'upstream request completed')
    } else if (this.#statusCode >= 400) {
      this.#logger.warn(data, 'upstream request completed')
    } else {
      this.#logger.debug(data, 'upstream request completed')
    }

    this.onDone()

    super.onComplete(trailers)
  }

  onError(err) {
    this.#timing.end = performance.now() - this.#created

    const data = {
      ures: {
        statusCode: this.#statusCode || undefined,
        headers: this.#headers,
        timing: this.#timing,
        bytesRead: this.#pos,
        bytesReadPerSecond:
          this.#timing.data >= 0 && this.#timing.end > this.#timing.data
            ? (this.#pos * 1e3) / (this.#timing.end - this.#timing.data)
            : 0,
      },
      elapsedTime: this.#timing.end,
      err,
    }

    if (this.#aborted) {
      this.#logger.debug(data, 'upstream request aborted')
    } else {
      this.#logger.error(data, 'upstream request failed')
    }

    this.onDone()

    super.onError(err)
  }

  onDone() {
    if (this[kGlobalIndex] !== -1) {
      const tmp = this[kGlobalArray].pop()
      if (tmp !== this) {
        this[kGlobalArray][this[kGlobalIndex]] = tmp
        tmp[kGlobalIndex] = this[kGlobalIndex]
      }
      this[kGlobalIndex] = -1
    }
  }
}

export default (logOpts) => (dispatch) => (opts, handler) =>
  opts.logger ? dispatch(opts, new Handler(logOpts, opts, { handler })) : dispatch(opts, handler)
