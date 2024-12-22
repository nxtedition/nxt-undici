import tp from 'node:timers/promises'
import cacheControlParser from 'cache-control-parser'
import stream from 'node:stream'
import { util } from 'undici'

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

// Parsed accordingly to RFC 9110
// https://www.rfc-editor.org/rfc/rfc9110#field.content-range
export function parseRangeHeader(range) {
  if (range == null || range === '') {
    return { start: 0, end: null, size: null }
  }

  const m = range ? range.match(/^bytes (\d+)-(\d+)\/(\d+)?$/) : null
  return m
    ? {
        start: parseInt(m[1]),
        end: m[2] ? parseInt(m[2]) + 1 : null,
        size: m[3] ? parseInt(m[3]) : null,
      }
    : null
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

export function parseContentRange(range) {
  if (typeof range !== 'string') {
    return null
  }

  const m = range.match(/^bytes (\d+)-(\d+)?\/(\d+|\*)$/)
  if (!m) {
    return null
  }

  const start = m[1] == null ? null : Number(m[1])
  if (!Number.isFinite(start)) {
    return null
  }

  const end = m[2] == null ? null : Number(m[2])
  if (end !== null && !Number.isFinite(end)) {
    return null
  }

  const size = m[2] === '*' ? null : Number(m[2])
  if (size !== null && !Number.isFinite(size)) {
    return null
  }

  return { start, end: end ? end + 1 : size, size }
}

export async function retry(err, retryCount, opts) {
  if (!opts) {
    throw err
  }

  if (typeof opts === 'function') {
    return opts(err, retryCount, opts, (opts) => retry(err, retryCount, opts))
  }

  if (typeof opts === 'number') {
    opts = { count: opts }
  }

  const retryMax = opts?.count ?? 8

  if (retryCount > retryMax) {
    throw err
  }

  const statusCode = err.statusCode ?? err.status ?? err.$metadata?.httpStatusCode ?? null

  if (statusCode && [420, 429, 502, 503, 504].includes(statusCode)) {
    let retryAfter = err.headers?.['retry-after'] ? err.headers['retry-after'] * 1e3 : null
    retryAfter = Number.isFinite(retryAfter) ? retryAfter : Math.min(10e3, retryCount * 1e3)
    if (retryAfter != null && Number.isFinite(retryAfter)) {
      return tp.setTimeout(retryAfter, undefined, { signal: opts.signal })
    } else {
      return null
    }
  }

  if (
    err.code &&
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ENETDOWN',
      'ENETUNREACH',
      'EHOSTDOWN',
      'EHOSTUNREACH',
      'EPIPE',
    ].includes(err.code)
  ) {
    return tp.setTimeout(Math.min(10e3, retryCount * 1e3), undefined, { signal: opts.signal })
  }

  if (err.message && ['other side closed'].includes(err.message)) {
    return tp.setTimeout(Math.min(10e3, retryCount * 1e3), undefined, { signal: opts.signal })
  }

  throw err
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
    let origin = url.origin != null ? url.origin : `${url.protocol}//${url.hostname}:${port}`
    let path = url.path != null ? url.path : `${url.pathname || ''}${url.search || ''}`

    if (origin.endsWith('/')) {
      origin = origin.substring(0, origin.length - 1)
    }

    if (path && !path.startsWith('/')) {
      path = `/${path}`
    }
    // new URL(path, origin) is unsafe when `path` contains an absolute URL
    // From https://developer.mozilla.org/en-US/docs/Web/API/URL/URL:
    // If first parameter is a relative URL, second param is required, and will be used as the base URL.
    // If first parameter is an absolute URL, a given second param will be ignored.
    url = new URL(origin + path)
  }

  return url
}

export function parseOrigin(url) {
  url = module.exports.parseURL(url)

  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('invalid url')
  }

  return url
}

export class AbortError extends Error {
  constructor(message) {
    super(message ?? 'The operation was aborted')
    this.code = 'ABORT_ERR'
    this.name = 'AbortError'
  }
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

  constructor(handler) {
    if (typeof handler !== 'object' || handler === null) {
      throw new TypeError('handler must be an object')
    }
    this.#handler = handler
  }

  onConnect(...args) {
    return this.#handler.onConnect?.(...args)
  }

  onError(...args) {
    return this.#handler.onError?.(...args)
  }

  onUpgrade(...args) {
    return this.#handler.onUpgrade?.(...args)
  }

  onHeaders(...args) {
    return this.#handler.onHeaders?.(...args)
  }

  onData(...args) {
    return this.#handler.onData?.(...args)
  }

  onComplete(...args) {
    return this.#handler.onComplete?.(...args)
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

      if (val) {
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

      if (val) {
        if (!Array.isArray(val)) {
          val = [val]
          obj[key] = val
        }
        if (Array.isArray(val2)) {
          val.push(...val2.filter((x) => x != null).map((x) => `${x}`))
        } else {
          val.push(`${val2}`)
        }
      } else if (val2 != null) {
        obj[key] = Array.isArray(val2)
          ? val2.filter((x) => x != null).map((x) => `${x}`)
          : `${val2}`
      }
    }
  } else if (headers != null) {
    throw new Error('invalid argument: headers')
  }

  // See https://github.com/nodejs/node/pull/46528
  if ('content-length' in obj && 'content-disposition' in obj) {
    obj['content-disposition'] = Buffer.from(obj['content-disposition']).toString('latin1')
  }

  return obj
}
