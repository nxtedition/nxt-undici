import undici from '@nxtedition/undici'
import { DecoratorHandler, parseCacheControl } from '../utils.js'

const DEFAULT_STORE = new undici.cacheStores.SqliteCacheStore({ location: ':memory:' })
const DEFAULT_MAX_ENTRY_SIZE = 128 * 1024
const NOOP = () => {}

class CacheHandler extends DecoratorHandler {
  #key
  #value
  #store
  #maxEntrySize

  constructor(key, { store, handler, maxEntrySize }) {
    undici.util.cache.assertCacheKey(key)

    super(handler)

    this.#key = key
    this.#value = null
    this.#store = store
    this.#maxEntrySize = maxEntrySize ?? store.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE
  }

  onConnect(abort) {
    this.#value = null

    super.onConnect(abort)
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode !== 307 && statusCode !== 200) {
      return super.onHeaders(statusCode, headers, resume)
    }

    if (headers.vary === '*' || headers.trailers) {
      // Not cacheble...
      return super.onHeaders(statusCode, headers, resume)
    }

    const contentLength = headers['content-length'] ? Number(headers['content-length']) : Infinity
    if (Number.isFinite(contentLength) && contentLength > DEFAULT_MAX_ENTRY_SIZE) {
      // We don't support caching responses with body...
      return super.onHeaders(statusCode, headers, resume)
    }

    const cacheControlDirectives = parseCacheControl(headers['cache-control']) ?? {}

    if (this.#key.headers.authorization && !cacheControlDirectives.public) {
      return super.onHeaders(statusCode, headers, resume)
    }

    if (cacheControlDirectives.private || cacheControlDirectives['no-store']) {
      return super.onHeaders(statusCode, headers, resume)
    }

    if (cacheControlDirectives['must-understand']) {
      // Do nothing. We only cache responses that we understand...
    }

    if (cacheControlDirectives['no-transform']) {
      // Do nothing. We don't transform responses...
    }

    if (
      cacheControlDirectives['must-revalidate'] ||
      cacheControlDirectives['proxy-revalidate'] ||
      cacheControlDirectives['stale-while-revalidate'] ||
      cacheControlDirectives['stale-if-error'] ||
      cacheControlDirectives['no-cache']
    ) {
      // TODO (fix): Support all cache control directives...
      return super.onHeaders(statusCode, headers, resume)
    }

    const vary = {}
    if (headers.vary) {
      if (typeof headers.vary !== 'string') {
        return super.onHeaders(statusCode, headers, resume)
      }

      for (const key of headers.vary.split(',').map((key) => key.trim().toLowerCase())) {
        const val = this.#key.headers[key]
        if (val != null) {
          vary[key] = this.#key.headers[key]
        }
      }
    }

    const ttl = cacheControlDirectives.immutable
      ? 31556952
      : Number(cacheControlDirectives['s-max-age'] ?? cacheControlDirectives['max-age'])
    if (!ttl || !Number.isFinite(ttl) || ttl <= 0) {
      return super.onHeaders(statusCode, headers, resume)
    }

    const cachedAt = Date.now()

    this.#value = {
      body: [],
      size: 0,
      deleteAt: cachedAt + ttl * 1e3,
      statusCode,
      statusMessage: '',
      headers,
      cacheControlDirectives,
      etag: headers.etag,
      vary,
      cachedAt,
      staleAt: 0,
    }

    return super.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    if (this.#value) {
      this.#value.size += chunk.length
      this.#value.body.push(chunk)

      if (this.#value.size > this.#maxEntrySize) {
        this.#value = null
        this.#value.size = 0
      }
    }

    return super.onData(chunk)
  }

  onComplete(trailers) {
    if (this.#value && (!trailers || Object.keys(trailers).length === 0)) {
      this.#store.set(this.#key, this.#value)
    }

    super.onComplete(trailers)
  }
}

export default () => (dispatch) => (opts, handler) => {
  if (!opts.cache || opts.upgrade) {
    return dispatch(opts, handler)
  }

  if (opts.method !== 'GET' && opts.method !== 'HEAD') {
    return dispatch(opts, handler)
  }

  const cacheControlDirectives = parseCacheControl(opts?.headers['cache-control']) ?? {}

  if (cacheControlDirectives['no-transform']) {
    // Do nothing. We don't transform requests...
  }

  if (
    cacheControlDirectives['max-age'] ||
    cacheControlDirectives['max-stale'] ||
    cacheControlDirectives['min-fresh'] ||
    cacheControlDirectives['no-cache'] ||
    cacheControlDirectives['stale-if-error']
  ) {
    // TODO (fix): Support all cache control directives...
    return dispatch(opts, handler)
  }

  // Dump body...
  opts.body?.on('error', () => {}).resume()

  const store = opts.cache.store ?? DEFAULT_STORE
  const entry = store.get(opts)
  if (!entry && !cacheControlDirectives['only-if-cached']) {
    return dispatch(
      opts,
      cacheControlDirectives['no-store']
        ? handler
        : new CacheHandler(undici.util.cache.makeCacheKey(opts), {
            maxEntrySize: opts.cache.maxEntrySize,
            store,
            handler,
          }),
    )
  }

  const { statusCode, headers, body } = entry ?? { statusCode: 504, headers: {} }

  let aborted = false
  const abort = (reason) => {
    if (!aborted) {
      aborted = true
      handler.onError(reason)
    }
  }

  handler.onConnect(abort)
  if (aborted) {
    return
  }

  handler.onHeaders(statusCode, headers, NOOP)
  if (aborted) {
    return
  }

  if (body?.byteLength) {
    handler.onData(body)
    if (aborted) {
      return
    }
  }

  handler.onComplete({})
}
