import { DecoratorHandler, parseHeaders } from '../utils.js'

const kGlobalIndex = Symbol.for('@nxtedition/nxt-undici#globalIndex')
const kGlobalArray = Symbol.for('@nxtedition/nxt-undici#globalArray')

const REDACTED = '[redacted]'

// Header names (lowercase) whose values must never reach the logs.
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie'])

// Allocation-free pre-scan: true when `headers` is a plain object that the
// parse + redact path would reproduce verbatim — every key already lowercase,
// every value a string (or array of strings), no secret header present. In
// that case the original object can be logged as-is: log bindings only read
// it (pino serializes child bindings eagerly), nothing in the pipeline
// mutates a caller's headers object in place.
function isCleanHeaderObject(headers) {
  for (const key of Object.keys(headers)) {
    if (SECRET_HEADERS.has(key) || key.toLowerCase() !== key) {
      return false
    }
    const val = headers[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item !== 'string') {
          return false
        }
      }
    } else if (typeof val !== 'string') {
      return false
    }
  }
  return true
}

// Return a loggable view of `headers` with credential values replaced by a
// redaction marker. Copy-on-write: the common case (already-lowercased plain
// object, string values, nothing to redact) returns the original object
// without allocating. Only when something actually needs work — flat-array
// form ([name, value, name, value, ...] with Buffer or string entries from
// onHeaders/onUpgrade), a secret header, a non-lowercase name, or a
// non-string value — do we build a sanitized copy via parseHeaders, which
// lowercases names, stringifies values (Buffers included, so no
// `{type:'Buffer',data:[...]}` blobs in bindings), skips null/undefined, and
// merges duplicate names into arrays instead of overwriting earlier values.
function sanitizeHeaders(headers) {
  if (headers == null || typeof headers !== 'object') {
    return undefined
  }

  if (!Array.isArray(headers) && isCleanHeaderObject(headers)) {
    return headers
  }

  const sanitized = parseHeaders(headers)

  for (const name of SECRET_HEADERS) {
    if (name in sanitized) {
      sanitized[name] = REDACTED
    }
  }

  return sanitized
}

// Normalize the request origin for logging without leaking userinfo
// credentials embedded as `http://user:pass@host`. Copy-on-write: userinfo
// requires an '@', so a string without one is returned as-is — no URL
// allocation. Real `URL` instances already expose a credential-free
// `origin`; arbitrary URL-like objects do NOT get that fast path, since a
// plain `{ origin: 'http://user:pass@host' }` would bypass the userinfo
// check. Everything else is stringified, and only strings that could carry
// userinfo are parsed and reduced to URL#origin (which never contains
// userinfo); if such a string is not a parseable URL, prefer losing the
// value over risking embedded credentials.
function sanitizeOrigin(origin) {
  if (origin == null) {
    return undefined
  }
  if (origin instanceof URL) {
    return origin.origin
  }
  const str = typeof origin === 'string' ? origin : String(origin)
  if (!str.includes('@')) {
    return str
  }
  try {
    return new URL(str).origin
  } catch {
    return REDACTED
  }
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
  if (Buffer.isBuffer(body)) {
    return `Buffer(${body.byteLength} bytes)`
  }
  if (ArrayBuffer.isView(body)) {
    return `${body.constructor?.name ?? 'TypedArray'}(${body.byteLength} bytes)`
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
    origin: sanitizeOrigin(opts.origin),
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
