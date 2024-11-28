import assert from 'node:assert'
import { LRUCache } from 'lru-cache'
import { DecoratorHandler, parseHeaders, parseCacheControl } from '../utils.js'

class CacheHandler extends DecoratorHandler {
  #handler
  #store
  #key
  #value = null

  constructor({ key, handler, store }) {
    super(handler)

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
      contentLength < maxEntrySize &&
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
      const ttl = cacheControl.immutable
        ? 31556952 // 1 year
        : Number(maxAge)

      if (ttl > 0) {
        this.#value = {
          data: {
            statusCode,
            statusMessage,
            headers,
            body: [],
          },
          size:
            (rawHeaders?.reduce((xs, x) => xs + x.length, 0) ?? 0) +
            (statusMessage?.length ?? 0) +
            64,
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
      this.#store.set(this.#key, this.#value.data, { ttl: this.#value.ttl, size: this.#value.size })
    }
    return this.#handler.onComplete()
  }
}

// TODO (fix): Async filesystem cache.
class CacheStore {
  constructor({ maxSize = 1024 * 1024, maxEntrySize = 128 * 1024 }) {
    this.maxSize = maxSize
    this.maxEntrySize = maxEntrySize
    this.cache = new LRUCache({ maxSize })
  }

  set(key, value, opts) {
    this.cache.set(key, value, opts)
  }

  get(key) {
    return this.cache.get(key)
  }
}

function makeKey(opts) {
  // NOTE: Ignores headers...
  return `${opts.origin}:${opts.method}:${opts.path}`
}

const DEFAULT_CACHE_STORE = new CacheStore({ maxSize: 128 * 1024, maxEntrySize: 1024 })

export default (opts) => (dispatch) => (opts, handler) => {
  if (!opts.cache || opts.upgrade) {
    return dispatch(opts, handler)
  }

  // TODO (fix): Cache other methods?
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

  // TODO (fix): Support body...
  assert(opts.method === 'GET' || opts.method === 'HEAD')

  // Dump body...
  opts.body?.on('error', () => {}).resume()

  const store = opts.cache === true ? DEFAULT_CACHE_STORE : opts.cache

  if (!store) {
    throw new Error(`Cache store not provided.`)
  }

  let key = makeKey(opts)
  let value = store.get(key)

  if (value == null && opts.method === 'HEAD') {
    key = makeKey({ ...opts, method: 'GET' })
    value = store.get(key)
  }

  if (value) {
    const { statusCode, statusMessage, headers, body } = value
    const ac = new AbortController()
    const signal = ac.signal

    const resume = () => {}
    const abort = () => {
      ac.abort()
    }

    try {
      handler.onConnect(abort)
      signal.throwIfAborted()
      handler.onHeaders(statusCode, null, resume, statusMessage, headers)
      signal.throwIfAborted()
      if (opts.method !== 'HEAD') {
        for (const chunk of body) {
          const ret = handler.onData(chunk)
          signal.throwIfAborted()
          if (ret === false) {
            // TODO (fix): back pressure...
          }
        }
        handler.onComplete()
      } else {
        handler.onComplete()
      }
    } catch (err) {
      handler.onError(err)
    }

    return true
  } else {
    return dispatch(opts, new CacheHandler({ handler, store, key: makeKey(opts) }))
  }
}
