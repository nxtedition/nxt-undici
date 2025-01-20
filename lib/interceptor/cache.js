import { SqliteCacheStore } from '../cache/sqlite-cache-store.js'
import { DecoratorHandler, parseCacheControl } from '../utils.js'

const DEFAULT_STORE = new SqliteCacheStore({ location: ':memory:' })
const MAX_ENTRY_SIZE = 128 * 1024

class CacheHandler extends DecoratorHandler {
  #value
  #opts
  #store

  constructor(opts, { store, handler }) {
    super(handler)

    this.#opts = opts
    this.#store = store
  }

  onConnect(abort) {
    this.#value = null

    super.onConnect(abort)
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode !== 307) {
      // Only cache redirects...
      return super.onHeaders(statusCode, headers, resume)
    }

    if (headers.vary === '*' || headers.trailers) {
      // Not cacheble...
      return super.onHeaders(statusCode, headers, resume)
    }

    const contentLength = headers['content-length'] ? Number(headers['content-length']) : Infinity
    if (Number.isFinite(contentLength) && contentLength > MAX_ENTRY_SIZE) {
      // We don't support caching responses with body...
      return super.onHeaders(statusCode, headers, resume)
    }

    const cacheControl = parseCacheControl(headers['cache-control'])
    if (
      !cacheControl ||
      !cacheControl.public ||
      cacheControl.private ||
      cacheControl['no-store'] ||
      // TODO (fix): Support all cache control directives...
      // cacheControl['no-transform'] ||
      cacheControl['no-cache'] ||
      cacheControl['must-understand'] ||
      cacheControl['must-revalidate'] ||
      cacheControl['proxy-revalidate']
    ) {
      // Not cacheble...
      return super.onHeaders(statusCode, headers, resume)
    }

    const vary = {}
    if (headers.vary) {
      for (const key of [headers.vary]
        .flat()
        .flatMap((vary) => vary.split(',').map((key) => key.trim().toLowerCase()))) {
        const val = this.#opts.headers?.[key]
        if (!val) {
          // Expect vary headers to be present...
          return super.onHeaders(statusCode, headers, resume)
        }
        vary[key] = val
      }

      // Unexpected vary header type...
      return super.onHeaders(statusCode, headers, resume)
    }

    const ttl = cacheControl.immutable
      ? 31556952
      : Number(cacheControl['s-max-age'] ?? cacheControl['max-age'])
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
      cacheControlDirectives: '',
      etag: '',
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

      if (this.#value.size > MAX_ENTRY_SIZE) {
        this.#value = null
        this.#value.size = 0
      }
    }

    return super.onData(chunk)
  }

  onComplete(trailers) {
    if (this.#value && (!trailers || Object.keys(trailers).length === 0)) {
      this.#store.set(this.#opts, this.#value)
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

  const store = opts.cache.store ?? DEFAULT_STORE
  const entry = store.get(opts)
  if (!entry) {
    return dispatch(opts, new CacheHandler(opts.headers, { store, handler }))
  }

  let aborted = false
  let paused = false
  const abort = (reason) => {
    if (!aborted) {
      aborted = true
      handler.onError(reason)
    }
  }
  const resume = () => {
    if (paused && !aborted) {
      handler.onComplete()
      paused = false
    }
  }

  const { statusCode, headers } = entry
  try {
    handler.onConnect(abort)
    if (aborted) {
      return
    }

    if (handler.onHeaders(statusCode, headers, resume) === false) {
      paused = true
    }

    if (aborted) {
      return
    }

    if (!paused) {
      handler.onComplete()
    }
  } catch (err) {
    abort(err)
  }
}
