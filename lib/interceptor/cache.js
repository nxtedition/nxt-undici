import { SqliteCacheStore } from '../cache/sqlite-cache-store.js'
import { DecoratorHandler, parseHeaders, parseCacheControl } from '../utils.js'

const DEFAULT_STORE = new SqliteCacheStore({ location: ':memory:' })

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

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    if (statusCode !== 307) {
      // Only cache redirects...
      return super.onHeaders(statusCode, null, resume, null, headers)
    }

    if (headers.vary === '*') {
      // Not cacheble...
      return super.onHeaders(statusCode, null, resume, null, headers)
    }

    const cacheControl = parseCacheControl(headers['cache-control'])
    const contentLength = headers['content-length'] ? Number(headers['content-length']) : Infinity

    if (contentLength) {
      // We don't support caching responses with body...
      return super.onHeaders(statusCode, null, resume, null, headers)
    }

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
      return super.onHeaders(statusCode, null, resume, null, headers)
    }

    const vary = {}
    if (headers.vary) {
      for (const key of [headers.vary]
        .flat()
        .flatMap((vary) => vary.split(',').map((key) => key.trim().toLowerCase()))) {
        const val = this.#opts.headers?.[key]
        if (!val) {
          // Expect vary headers to be present...
          return super.onHeaders(statusCode, null, resume, null, headers)
        }
        vary[key] = val
      }

      // Unexpected vary header type...
      return super.onHeaders(statusCode, null, resume, null, headers)
    }

    const ttl = cacheControl.immutable
      ? 31556952
      : Number(cacheControl['s-max-age'] ?? cacheControl['max-age'])
    if (!ttl || !Number.isFinite(ttl) || ttl <= 0) {
      return super.onHeaders(statusCode, null, resume, null, headers)
    }

    const cachedAt = Date.now()

    this.#value = {
      body: null,
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

    return super.onHeaders(statusCode, null, resume, null, headers)
  }

  onData(chunk) {
    this.#value = null
    return super.onData(chunk)
  }

  onComplete() {
    if (this.#value) {
      this.#store.set(this.#opts, this.#value)
    }
    super.onComplete()
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

  const store = opts.store ?? DEFAULT_STORE
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
      return true
    }

    if (handler.onHeaders(statusCode, null, resume, null, headers) === false) {
      paused = true
    }

    if (aborted) {
      return true
    }

    if (!paused) {
      handler.onComplete()
    }
  } catch (err) {
    abort(err)
  }

  return true
}
