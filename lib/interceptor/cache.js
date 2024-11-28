import { LRUCache } from 'lru-cache'
import { parseHeaders, parseCacheControl } from '../utils.js'

class CacheHandler {
  #handler
  #store
  #key
  #value

  constructor({ key, handler, store }) {
    this.#key = key
    this.#handler = handler
    this.#store = store
  }

  onConnect(abort) {
    this.#value = null

    return this.#handler.onConnect(abort)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    if (statusCode !== 307) {
      return this.#handler.onHeaders(statusCode, null, resume, statusMessage, headers)
    }

    // TODO (fix): Support vary header.
    const cacheControl = parseCacheControl(headers['cache-control'])

    const contentLength = headers['content-length'] ? Number(headers['content-length']) : Infinity
    const maxEntrySize = this.#store.maxEntrySize ?? Infinity

    if (
      (!contentLength || contentLength < maxEntrySize) &&
      cacheControl &&
      cacheControl.public &&
      !cacheControl.private &&
      !cacheControl['no-store'] &&
      // TODO (fix): Support all cache control directives...
      // !opts.headers['no-transform'] &&
      !cacheControl['no-cache'] &&
      !cacheControl['must-understand'] &&
      !cacheControl['must-revalidate'] &&
      !cacheControl['proxy-revalidate']
    ) {
      const maxAge = cacheControl['s-max-age'] ?? cacheControl['max-age']
      const ttl = cacheControl.immutable ? 31556952 : Number(maxAge)

      if (ttl > 0) {
        this.#value = {
          statusCode,
          statusMessage,
          headers,
          body: [],
          size: 256, // TODO (fix): Measure headers size...
          ttl: ttl * 1e3,
        }
      }
    }

    return this.#handler.onHeaders(statusCode, null, resume, statusMessage, headers)
  }

  onData(chunk) {
    if (this.#value) {
      this.#value.size += chunk.bodyLength

      const maxEntrySize = this.#store.maxEntrySize ?? Infinity
      if (this.#value.size > maxEntrySize) {
        this.#value = null
      } else {
        this.#value.data.body.push(chunk)
      }
    }
    return this.#handler.onData(chunk)
  }

  onComplete() {
    if (this.#value) {
      this.#store.set(
        this.#key,
        {
          statusCode: this.#value.statusCode,
          statusMessage: this.#value.statusMessage,
          headers: this.#value.headers,
          body: Buffer.concat(this.#value.body),
        },
        { ttl: this.#value.ttl, size: this.#value.size },
      )
    }
    return this.#handler.onComplete()
  }

  onError(err) {
    this.#handler.onError(err)
  }
}

class MemoryCacheStore {
  constructor({ maxSize = 1024 * 1024, maxEntrySize = 128 * 1024, maxTTL = 48 * 3600e3 }) {
    this.maxSize = maxSize
    this.maxEntrySize = maxEntrySize
    this.maxTTL = maxTTL
    this.cache = new LRUCache({ maxSize })
  }

  set(key, value, opts) {
    this.cache.set(
      key,
      value,
      opts
        ? {
            ttl: opts.ttl ? Math.min(opts.ttl, this.maxTTL) : undefined,
            size: opts.size,
          }
        : undefined,
    )
  }

  get(key) {
    return this.cache.get(key)
  }
}

function makeKey(opts) {
  // NOTE: Ignores headers...
  return `${opts.origin}:${opts.method}:${opts.path}`
}

const DEFAULT_CACHE_STORE = new MemoryCacheStore({ maxSize: 128 * 1024, maxEntrySize: 1024 })

export default (opts) => (dispatch) => (opts, handler) => {
  if (!opts.cache || opts.upgrade) {
    return dispatch(opts, handler)
  }

  if (opts.method !== 'GET' && opts.method !== 'HEAD') {
    return dispatch(opts, handler)
  }

  if (opts.headers?.['cache-control'] || opts.headers?.authorization) {
    // TODO (fix): Support all cache control directives...
    // const cacheControl = cacheControlParser.parse(opts.headers['cache-control'])
    // cacheControl['no-cache']
    // cacheControl['no-store']
    // cacheControl['max-age']
    // cacheControl['max-stale']
    // cacheControl['min-fresh']
    // cacheControl['no-transform']
    // cacheControl['only-if-cached']
    return dispatch(opts, handler)
  }

  // Dump body...
  opts.body?.on('error', () => {}).resume()

  const store = opts.cache === true ? DEFAULT_CACHE_STORE : opts.cache

  if (!store) {
    throw new Error(`Cache store not provided.`)
  }

  const key = makeKey(opts)
  const entry = store.get(key)

  if (!entry) {
    return dispatch(opts, new CacheHandler({ handler, store, key: makeKey(opts) }))
  }

  const { statusCode, statusMessage, headers, body } = entry

  let aborted = false
  const abort = () => {
    aborted = true
  }
  const resume = () => {}

  try {
    handler.onConnect(abort)
    if (aborted) {
      return true
    }

    handler.onHeaders(statusCode, null, resume, statusMessage, headers)
    if (aborted) {
      return true
    }

    if (body.byteKength > 0) {
      handler.onData(body)
      if (aborted) {
        return true
      }
    }

    handler.onComplete()
  } catch (err) {
    handler.onError(err)
  }

  return true
}
