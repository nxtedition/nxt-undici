import undici from '@nxtedition/undici'
import { DecoratorHandler, parseCacheControl, parseContentRange } from '../utils.js'
import { SqliteCacheStore } from '../sqlite-cache-store.js'

const DEFAULT_STORE = new SqliteCacheStore({ location: ':memory:' })
const DEFAULT_MAX_ENTRY_SIZE = 128 * 1024
const DEFAULT_MAX_ENTRY_TTL = 24 * 3600
const NOOP = () => {}

class CacheHandler extends DecoratorHandler {
  #key
  #value
  #store
  #logger
  #maxEntrySize
  #maxEntryTTL

  constructor(key, { store, logger, handler, maxEntrySize, maxEntryTTL }) {
    super(handler)

    this.#key = key
    this.#logger = logger
    this.#value = null
    this.#store = store
    this.#maxEntrySize = maxEntrySize ?? store.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE
    this.#maxEntryTTL = maxEntryTTL ?? store.maxEntryTTL ?? DEFAULT_MAX_ENTRY_TTL
  }

  onConnect(abort) {
    this.#value = null

    super.onConnect((reason) => {
      // TODO (fix): Cache partial results?
      abort(reason)
    })
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode !== 307 && statusCode !== 200 && statusCode !== 206) {
      return super.onHeaders(statusCode, headers, resume)
    }

    if (headers.vary === '*' || headers.trailers) {
      // Not cacheble...
      return super.onHeaders(statusCode, headers, resume)
    }

    let contentRange
    if (headers['content-range']) {
      contentRange = parseContentRange(headers['content-range'])
      if (contentRange === null) {
        // We don't support caching responses with invalid content-range...
        return super.onHeaders(statusCode, headers, resume)
      }
    }

    let contentLength
    if (headers['content-length']) {
      contentLength = Number(headers['content-length'])
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        // We don't support caching responses with invalid content-length...
        return super.onHeaders(statusCode, headers, resume)
      }
    }

    if (statusCode === 206 && !contentRange) {
      // We don't support caching range responses without content-range...
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

    const start = contentRange ? contentRange.start : 0
    const end = contentRange ? contentRange.end : contentLength

    if (end == null || end - start <= this.#maxEntrySize) {
      const cachedAt = Date.now()
      this.#value = {
        body: [],
        start,
        end,
        deleteAt: cachedAt + Math.min(ttl, this.#maxEntryTTL) * 1e3,
        statusCode,
        statusMessage: '',
        headers,
        cacheControlDirectives,
        etag: isEtagUsable(headers.etag) ? headers.etag : '',
        vary,
        cachedAt,
        staleAt: 0,
        // Handler state.
        size: 0,
      }
    }

    return super.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    if (this.#value) {
      this.#value.size += chunk.length
      this.#value.body.push(chunk)

      if (this.#value.size > this.#maxEntrySize) {
        this.#value = null
      }
    }

    return super.onData(chunk)
  }

  onComplete(trailers) {
    if (this.#value && (!trailers || Object.keys(trailers).length === 0)) {
      this.#value.end ??= this.#value.start + this.#value.size
      try {
        this.#store.set(this.#key, this.#value)
      } catch (err) {
        if (err.message === 'database is locked') {
          // Database is busy. We don't bother trying again...
          this.#logger?.debug({ err }, 'failed to set cache entry')
        } else {
          this.#logger?.error({ err }, 'failed to set cache entry')
        }
      }
      this.#value = null
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

  const store = opts.cache.store ?? DEFAULT_STORE

  // TODO (fix): enable range requests

  let entry
  try {
    entry = store.get(opts)
  } catch (err) {
    if (err.message === 'database is locked') {
      // Database is busy. We don't bother trying again...
      opts.logger?.debug({ err }, 'failed to set cache entry')
    } else {
      opts.logger?.error({ err }, 'failed to set cache entry')
    }
  }

  if (!entry && !cacheControlDirectives['only-if-cached']) {
    return dispatch(
      opts,
      cacheControlDirectives['no-store']
        ? handler
        : new CacheHandler(undici.util.cache.makeCacheKey(opts), {
            maxEntrySize: opts.cache.maxEntrySize,
            store,
            logger: opts.logger,
            handler,
          }),
    )
  }

  const { statusCode, headers, trailers, body } = entry ?? { statusCode: 504 }

  let aborted = false
  const abort = (reason) => {
    if (!aborted) {
      aborted = true
      handler.onError(reason)
    }
  }

  // Dump body...
  opts.body?.on('error', () => {}).resume()

  try {
    handler.onConnect(abort)
    if (aborted) {
      return
    }

    handler.onHeaders(statusCode, headers ?? {}, NOOP)
    if (aborted) {
      return
    }

    if (body?.byteLength) {
      handler.onData(body)
      if (aborted) {
        return
      }
    }

    handler.onComplete(trailers ?? {})
  } catch (err) {
    abort(err)
  }
}

/**
 * Note: this deviates from the spec a little. Empty etags ("", W/"") are valid,
 *  however, including them in cached resposnes serves little to no purpose.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9110.html#name-etag
 *
 * @param {string|any} etag
 * @returns {boolean}
 */
function isEtagUsable(etag) {
  if (typeof etag !== 'string') {
    return false
  }

  if (etag.length <= 2) {
    // Shortest an etag can be is two chars (just ""). This is where we deviate
    //  from the spec requiring a min of 3 chars however
    return false
  }

  if (etag[0] === '"' && etag[etag.length - 1] === '"') {
    // ETag: ""asd123"" or ETag: "W/"asd123"", kinda undefined behavior in the
    //  spec. Some servers will accept these while others don't.
    // ETag: "asd123"
    return !(etag[1] === '"' || etag.startsWith('"W/'))
  }

  if (etag.startsWith('W/"') && etag[etag.length - 1] === '"') {
    // ETag: W/"", also where we deviate from the spec & require a min of 3
    //  chars
    // ETag: for W/"", W/"asd123"
    return etag.length !== 4
  }

  // Anything else
  return false
}
