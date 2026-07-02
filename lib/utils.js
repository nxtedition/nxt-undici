import cacheControlParser from 'cache-control-parser'
import stream from 'node:stream'
import assert from 'node:assert'
import { util } from '@nxtedition/undici'
import createHttpError from 'http-errors'

let fastNow = Date.now()

setInterval(() => {
  fastNow = Date.now()
}, 1e3).unref()

export function getFastNow() {
  return fastNow
}

export function parseCacheControl(str) {
  return str ? cacheControlParser.parse(str) : null
}

export function isDisturbed(body) {
  if (
    body == null ||
    typeof body === 'string' ||
    Buffer.isBuffer(body) ||
    typeof body === 'function'
  ) {
    return false
  }

  if (body.readableDidRead === false) {
    return false
  }

  return stream.isDisturbed(body)
}

/**
 * @typedef {object} RangeHeader
 * @property {number} start
 * @property {number | null} end
 * @property {number | null} size
 */

/**
 * @param {string} [range]
 * @returns {RangeHeader|null|undefined}
 */
export function parseContentRange(range) {
  if (range == null || range === '') {
    return undefined
  }

  if (typeof range !== 'string') {
    return null
  }

  const m = range.match(/^bytes (\d+)-(\d+)?\/(\d+|\*)$/)
  return m
    ? {
        start: parseInt(m[1], 10),
        end: m[2] ? parseInt(m[2], 10) + 1 : null,
        size: m[3] === '*' ? null : parseInt(m[3], 10),
      }
    : null
}

// Parsed accordingly to RFC 9110
// https://www.rfc-editor.org/rfc/rfc9110#field.range
/**
 * @param {string} [range]
 * @returns {RangeHeader|null|undefined}
 */
export function parseRangeHeader(range) {
  if (range == null || range === '') {
    return undefined
  }

  if (typeof range !== 'string') {
    return null
  }

  const m = range.match(/^bytes=(\d+)-(\d+)?$/)
  return m
    ? {
        start: parseInt(m[1], 10),
        end: m[2] ? parseInt(m[2], 10) + 1 : null,
        size: null,
      }
    : null
}

export function parseURL(url) {
  if (typeof url === 'string') {
    url = new URL(url)

    if (!/^https?:/.test(url.origin || url.protocol)) {
      throw new Error('Invalid URL protocol: the URL must start with `http:` or `https:`.')
    }

    return url
  }

  if (!url || typeof url !== 'object') {
    throw new Error('Invalid URL: The URL argument must be a non-null object.')
  }

  if (url.port != null && url.port !== '' && !Number.isFinite(parseInt(url.port))) {
    throw new Error(
      'Invalid URL: port must be a valid integer or a string representation of an integer.',
    )
  }

  if (url.path != null && typeof url.path !== 'string') {
    throw new Error('Invalid URL path: the path must be a string or null/undefined.')
  }

  if (url.pathname != null && typeof url.pathname !== 'string') {
    throw new Error('Invalid URL pathname: the pathname must be a string or null/undefined.')
  }

  if (url.hostname != null && typeof url.hostname !== 'string') {
    throw new Error('Invalid URL hostname: the hostname must be a string or null/undefined.')
  }

  if (url.origin != null && typeof url.origin !== 'string') {
    throw new Error('Invalid URL origin: the origin must be a string or null/undefined.')
  }

  if (!/^https?:/.test(url.origin || url.protocol)) {
    throw new Error('Invalid URL protocol: the URL must start with `http:` or `https:`.')
  }

  if (!(url instanceof URL)) {
    const port = url.port != null ? url.port : url.protocol === 'https:' ? 443 : 80
    const origin = url.origin != null ? url.origin : `${url.protocol}//${url.hostname}:${port}`
    const path = url.path != null ? url.path : `${url.pathname || ''}${url.search || ''}`

    url = buildURL(origin, path)
  }

  return url
}

// Build an absolute URL from an origin and a path by concatenation.
//
// `new URL(path, origin)` is unsafe when `path` is itself absolute or
// protocol-relative (e.g. starts with `//host`): per the WHATWG URL spec, a
// protocol-relative first argument inherits only the scheme from the base and
// resolves its authority from `path`, so the origin's host is silently
// discarded. Concatenating `origin + path` and parsing the whole thing as a
// single absolute URL keeps the origin authoritative — which matters for
// redirect resolution, where a leaked host is an SSRF/misrouting vector.
//
// From https://developer.mozilla.org/en-US/docs/Web/API/URL/URL:
// If first parameter is a relative URL, second param is required, and will be used as the base URL.
// If first parameter is an absolute URL, a given second param will be ignored.
export function buildURL(origin, path) {
  origin = String(origin)
  path = path == null ? '' : String(path)

  if (origin.endsWith('/')) {
    origin = origin.substring(0, origin.length - 1)
  }

  if (path && !path.startsWith('/')) {
    path = `/${path}`
  }

  return new URL(origin + path)
}

export function parseOrigin(url) {
  url = parseURL(url)

  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('invalid url')
  }

  return url
}

export function isStream(obj) {
  return (
    obj && typeof obj === 'object' && typeof obj.pipe === 'function' && typeof obj.on === 'function'
  )
}

// based on https://github.com/node-fetch/fetch-blob/blob/8ab587d34080de94140b54f07168451e7d0b655e/index.js#L229-L241 (MIT License)
export function isBlobLike(object) {
  return (
    (Blob && object instanceof Blob) ||
    (object &&
      typeof object === 'object' &&
      (typeof object.stream === 'function' || typeof object.arrayBuffer === 'function') &&
      /^(Blob|File)$/.test(object[Symbol.toStringTag]))
  )
}

export function isBuffer(buffer) {
  // See, https://github.com/mcollina/undici/pull/319
  return buffer instanceof Uint8Array || Buffer.isBuffer(buffer)
}

export function bodyLength(body) {
  if (body == null) {
    return 0
  } else if (isStream(body)) {
    const state = body._readableState
    return state && state.ended === true && Number.isFinite(state.length) ? state.length : null
  } else if (isBlobLike(body)) {
    return body.size != null ? body.size : null
  } else if (isBuffer(body)) {
    return body.byteLength
  }

  return null
}

export class DecoratorHandler {
  #handler
  #aborted = false
  #errored = false
  #completed = false
  #abort

  constructor(handler) {
    if (typeof handler !== 'object' || handler === null) {
      throw new TypeError('handler must be an object')
    }
    this.#handler = handler
  }

  onConnect(abort) {
    this.#aborted = false
    this.#errored = false
    this.#completed = false
    this.#abort = abort

    return this.#handler.onConnect?.((reason) => {
      if (!this.#aborted && !this.#completed && !this.#errored) {
        this.#aborted = true
        this.#abort(reason)
      }
    })
  }

  onUpgrade(statusCode, headers, socket) {
    if (!this.#aborted && !this.#errored) {
      assert(!this.#completed)
      return this.#handler.onUpgrade?.(statusCode, headers, socket)
    }
  }

  onHeaders(statusCode, headers, resume) {
    if (!this.#aborted && !this.#errored) {
      assert(!this.#completed)
      return this.#handler.onHeaders?.(statusCode, headers, resume)
    }
  }

  onData(data) {
    if (!this.#aborted && !this.#errored && data != null) {
      assert(!this.#completed)
      return this.#handler.onData?.(data)
    }
  }

  onComplete(trailers) {
    if (!this.#aborted && !this.#completed && !this.#errored) {
      this.#completed = true
      return this.#handler.onComplete?.(trailers)
    }
  }

  onError(err) {
    if (!this.#errored && !this.#completed) {
      this.#errored = true
      return this.#handler.onError?.(err)
    }
  }
}

/**
 * @param {Record<string, string | string[] | null | undefined> | (Buffer | string | (Buffer | string)[])[]} headers
 * @param {Record<string, string | string[]>} [obj]
 * @returns {Record<string, string | string[]>}
 */
export function parseHeaders(headers, obj) {
  if (obj == null) {
    obj = {}
  } else {
    // TODO (fix): assert obj values type?
  }

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key2 = headers[i]
      const val2 = headers[i + 1]

      // TODO (fix): assert key2 type?
      // TODO (fix): assert val2 type?

      if (val2 == null) {
        continue
      }

      const key = util.headerNameToString(key2)
      let val = obj[key]

      // `key in obj`, not `if (val)`: an empty-string value ('') is a valid,
      // present header. A truthy check would treat it as absent and overwrite
      // it on a duplicate occurrence, silently dropping the first value.
      if (key in obj) {
        if (!Array.isArray(val)) {
          val = [val]
          obj[key] = val
        }

        if (Array.isArray(val2)) {
          val.push(...val2.filter((x) => x != null).map((x) => `${x}`))
        } else {
          val.push(`${val2}`)
        }
      } else {
        obj[key] = Array.isArray(val2)
          ? val2.filter((x) => x != null).map((x) => `${x}`)
          : `${val2}`
      }
    }
  } else if (typeof headers === 'object' && headers !== null) {
    for (const key2 of Object.keys(headers)) {
      const val2 = headers[key2]

      // TODO (fix): assert key2 type?
      // TODO (fix): assert val2 type?

      if (val2 == null) {
        continue
      }

      const key = util.headerNameToString(key2)
      let val = obj[key]

      // See the array branch above: presence check, not truthiness, so a
      // stored empty string is not clobbered by a later duplicate.
      if (key in obj) {
        if (!Array.isArray(val)) {
          val = [val]
          obj[key] = val
        }
        if (Array.isArray(val2)) {
          val.push(...val2.filter((x) => x != null).map((x) => `${x}`))
        } else {
          val.push(`${val2}`)
        }
      } else {
        obj[key] = Array.isArray(val2)
          ? val2.filter((x) => x != null).map((x) => `${x}`)
          : `${val2}`
      }
    }
  } else if (headers != null) {
    throw new Error('invalid argument: headers')
  }

  return obj
}

export function decorateError(err, opts, { statusCode, headers, trailers, body }) {
  try {
    if (err == null) {
      const stackTraceLimit = Error.stackTraceLimit
      Error.stackTraceLimit = 0
      try {
        err = createHttpError(statusCode)
      } finally {
        Error.stackTraceLimit = stackTraceLimit
      }
    }

    if (statusCode != null) {
      err.statusCode = statusCode
    }

    err.req = {
      path: opts.path,
      origin: opts.origin,
      method: opts?.method,
      headers: opts?.headers,
    }

    if (Array.isArray(body) && body.every((x) => Buffer.isBuffer(x))) {
      body = Buffer.concat(body).toString()
    } else if (typeof body !== 'string') {
      body = null
    }

    // A duplicated content-type response header arrives as an array (undici's
    // parseHeaders collapses repeats); coerce to the first value before
    // calling string methods, otherwise this throws and the catch below
    // discards all decoration into an opaque AggregateError.
    const contentType = Array.isArray(headers?.['content-type'])
      ? headers['content-type'][0]
      : headers?.['content-type']
    if (typeof body === 'string' && (!contentType || contentType.startsWith('application/json'))) {
      try {
        body = JSON.parse(body)
      } catch {
        // Do nothing...
      }
    }

    err.res = {
      headers,
      trailers,
      statusCode,
    }

    if (body) {
      err.body = body
      if (body.reason != null) {
        err.reason ??= body.reason
      }
      if (body.code != null) {
        err.code ??= body.code
      }
      if (body.error != null) {
        err.error ??= body.error
      }
    }

    return err
  } catch (er) {
    return new AggregateError([er, err])
  }
}
