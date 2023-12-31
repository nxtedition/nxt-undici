import assert from 'node:assert'
import { LRUCache } from 'lru-cache'
import { findHeader, parseCacheControl } from '../utils.js'

class CacheHandler {
  constructor({ key, handler, store }) {
    this.key = key
    this.handler = handler
    this.store = store
    this.value = null
  }

  onConnect(abort) {
    return this.handler.onConnect(abort)
  }

  onUpgrade(statusCode, rawHeaders, socket, headers) {
    return this.handler.onUpgrade(statusCode, rawHeaders, socket, headers)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers) {
    // NOTE: Only cache 307 respones for now...
    if (statusCode !== 307) {
      return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
    }

    const cacheControl = parseCacheControl(findHeader(rawHeaders, 'cache-control'))

    if (
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
        this.value = {
          statusCode,
          statusMessage,
          rawHeaders,
          rawTrailers: null,
          body: [],
          size: 0,
          ttl: ttl * 1e3,
        }
      }
    }

    return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
  }

  onData(chunk) {
    if (this.value) {
      this.value.size += chunk.bodyLength
      if (this.value.size > this.store.maxEntrySize) {
        this.value = null
      } else {
        this.value.body.push(chunk)
      }
    }
    return this.handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    if (this.value) {
      this.value.rawTrailers = rawTrailers
      this.store.set(this.key, this.value, this.value.ttl)
    }
    return this.handler.onComplete(rawTrailers)
  }

  onError(err) {
    return this.handler.onError(err)
  }
}

// TODO (fix): Async filesystem cache.
class CacheStore {
  constructor({ maxSize, maxEntrySize }) {
    this.maxSize = maxSize
    this.maxEntrySize = maxEntrySize
    this.cache = new LRUCache({
      maxSize,
      sizeCalculation: (value) => value.body.byteLength,
    })
  }

  set(key, value, ttl) {
    this.cache.set(key, value, ttl)
  }

  get(key) {
    return this.cache.get(key)
  }
}

function makeKey(opts) {
  // NOTE: Ignores headers...
  return `${opts.method}:${opts.path}`
}

const DEFAULT_CACHE_STORE = new CacheStore({ maxSize: 128 * 1024, maxEntrySize: 1024 })

export default (dispatch) => (opts, handler) => {
  if (!opts.cache || opts.upgrade) {
    return dispatch(opts, handler)
  }

  if (opts.method !== 'GET' && opts.method !== 'HEAD') {
    dispatch(opts, handler)
    return
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
    dispatch(opts, handler)
    return
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
    const { statusCode, statusMessage, rawHeaders, rawTrailers, body } = value
    const ac = new AbortController()
    const signal = ac.signal

    const resume = () => {}
    const abort = () => {
      ac.abort()
    }

    try {
      handler.onConnect(abort)
      signal.throwIfAborted()
      handler.onHeaders(statusCode, rawHeaders, resume, statusMessage)
      signal.throwIfAborted()
      if (opts.method !== 'HEAD') {
        for (const chunk of body) {
          const ret = handler.onData(chunk)
          signal.throwIfAborted()
          if (ret === false) {
            // TODO (fix): back pressure...
          }
        }
        handler.onComplete(rawTrailers)
        signal.throwIfAborted()
      } else {
        handler.onComplete([])
        signal.throwIfAborted()
      }
    } catch (err) {
      handler.onError(err)
    }
  } else {
    dispatch(opts, new CacheHandler({ handler, store, key: makeKey(opts) }))
  }
}
