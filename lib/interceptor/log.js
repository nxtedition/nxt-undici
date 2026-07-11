import { DecoratorHandler, parseHeaders } from '../utils.js'
import { traceWrite, traceSafe, traceErr, traceUrl } from '../trace.js'

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
// mutates a caller's headers object in place. Uses a `for..in` + `Object.hasOwn`
// guard rather than `Object.keys` so the scan itself allocates nothing while
// still ignoring inherited props exactly as `Object.keys` would.
function isCleanHeaderObject(headers) {
  for (const key in headers) {
    if (!Object.hasOwn(headers, key)) {
      continue
    }
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
// object, string values, nothing to redact) returns the original object as-is,
// allocating no new headers object (the pre-scan itself is allocation-free
// too). Only when something actually needs work — flat-array
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

  // Trace emission (op 'undici:request') lives in this handler alongside
  // logging: both observe the same lifecycle (start, status, bytes, terminal
  // event, sync-dispatch-throw finalization), so a second decorator layer
  // would duplicate the bookkeeping. `#write` is the trace fn resolved once
  // per request (capture-once: the same fn emits both the start and the end
  // doc, so a writer flipping mid-request cannot break the pairing) and null
  // when tracing is off. Logging and tracing are independently optional; the
  // dispatch entry only constructs this handler when at least one is active.
  #write
  #traceUrl
  #upgraded = false

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

  #opts
  #statusCode
  #headers

  constructor(write, logOpts, opts, { handler }) {
    super(handler)

    this.#opts = opts
    this.#write = write

    if (write !== null) {
      this.#traceUrl = traceUrl(opts)

      traceSafe(
        write,
        { phase: 'start', id: opts.id ?? null, method: opts.method ?? null, url: this.#traceUrl },
        'undici:request',
      )
    }

    if (opts.logger) {
      this.#ureq = sanitizeRequest(opts)
      this.#logger = opts.logger.child({ ureq: this.#ureq })

      if (logOpts?.bindings) {
        this.#logger = this.#logger.child(logOpts?.bindings)
      }

      this.#logger.debug('upstream request started')
    } else {
      this.#logger = null
    }

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
    this.#statusCode = statusCode
    // After an upgrade the socket is handed over and no onComplete/onError
    // will ever arrive — close of the upgraded socket is the end of the
    // request. Bytes are not tracked on an upgraded socket.
    this.#upgraded = true

    this.#logger?.debug(
      {
        ures: { statusCode, headers: sanitizeHeaders(headers) },
        elapsedTime: this.#timing.headers,
      },
      'upstream request upgrade',
    )

    socket.on('close', () => {
      this.#logger?.debug('upstream request socket closed')
      this.onDone(null)
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

    if (this.#logger) {
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
    }

    this.onDone(null)

    super.onComplete(trailers)
  }

  onError(err) {
    this.#timing.end = performance.now() - this.#created

    // Retry/response decorators can surface an error for a later attempt
    // after this handler observed headers from an earlier one. Prefer the
    // status attached to the terminal error so both the failure log and the
    // request trace describe the attempt that actually failed. The retained
    // headers remain those exposed for the logical response.
    if (err?.statusCode != null) {
      this.#statusCode = err.statusCode
    }

    if (this.#logger) {
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
    }

    this.onDone(err)

    super.onError(err)
  }

  // Terminal finalization, reached exactly once per request from every end
  // path (onComplete, onError, upgraded-socket close, onDispatchError): the
  // in-flight registry entry is the once-guard. Deregistration happens BEFORE
  // the trace end doc is emitted so a misbehaving writer can never observe —
  // or re-enter — a handler that still looks in flight.
  onDone(err) {
    if (this[kGlobalIndex] !== -1) {
      const tmp = this[kGlobalArray].pop()
      if (tmp !== this) {
        this[kGlobalArray][this[kGlobalIndex]] = tmp
        tmp[kGlobalIndex] = this[kGlobalIndex]
      }
      this[kGlobalIndex] = -1

      if (this.#write !== null) {
        traceSafe(
          this.#write,
          {
            phase: 'end',
            id: this.#opts.id ?? null,
            method: this.#opts.method ?? null,
            url: this.#traceUrl,
            statusCode: this.#statusCode ?? null,
            durationMs: Math.round(performance.now() - this.#created),
            bytes: this.#upgraded ? null : this.#pos,
            err: err != null ? traceErr(err) : null,
          },
          'undici:request',
        )
      }
    }
  }

  // Finalization for a request whose inner dispatch threw synchronously:
  // undici never took ownership of the handler, so no terminal callback
  // (onError/onComplete) will ever arrive. Log the failure, emit the trace
  // end doc and deregister from the in-flight registry. Deliberately does
  // NOT forward onError — the dispatch entry below rethrows and an outer
  // interceptor (lookup) delivers the error to the original handler chain,
  // so forwarding here would double-deliver it.
  onDispatchError(err) {
    if (this[kGlobalIndex] === -1) {
      // A terminal callback already ran before the error escaped dispatch
      // (e.g. onError was delivered and the error was then rethrown):
      // already logged and deregistered.
      return
    }

    this.#timing.end = performance.now() - this.#created

    this.#logger?.error({ err, elapsedTime: this.#timing.end }, 'upstream request failed')

    this.onDone(err)
  }
}

export default (logOpts) => (dispatch) => (opts, handler) => {
  // Capture-once per request (see Handler#write). Resolution cost when both
  // logging and tracing are off is one property read plus a typeof check.
  const write = traceWrite(opts.trace)

  if (!opts.logger && write === null) {
    return dispatch(opts, handler)
  }

  const logHandler = new Handler(write, logOpts, opts, { handler })

  try {
    const result = dispatch(opts, logHandler)
    return result != null && typeof result.then === 'function'
      ? Promise.resolve(result).catch((err) => {
          logHandler.onDispatchError(err)
          throw err
        })
      : result
  } catch (err) {
    // An inner interceptor threw synchronously at dispatch time (e.g. proxy
    // loop detection). The error escapes past the already-registered handler,
    // which would otherwise stay in the global in-flight registry forever.
    // Finalize it and rethrow so outer interceptors observe the same error
    // as before.
    logHandler.onDispatchError(err)
    throw err
  }
}
