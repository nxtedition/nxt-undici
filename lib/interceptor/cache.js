import undici from '@nxtedition/undici'
import { DecoratorHandler, getFastNow, parseCacheControl, parseContentRange } from '../utils.js'
import { SqliteCacheStore } from '../sqlite-cache-store.js'

let DEFAULT_STORE = null
const DEFAULT_MAX_ENTRY_SIZE = 128 * 1024
const DEFAULT_MAX_ENTRY_TTL = 30 * 24 * 3600
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

    // 'trailer' is the RFC 9110 field name; 'trailers' is kept for backwards
    // compatibility with servers that misspell it.
    if (headers.vary === '*' || headers.trailer || headers.trailers) {
      // Not cacheble...
      return super.onHeaders(statusCode, headers, resume)
    }

    if (headers['set-cookie']) {
      // Shared cache: replaying Set-Cookie to other clients leaks sessions.
      return super.onHeaders(statusCode, headers, resume)
    }

    let contentRange
    if (headers['content-range']) {
      contentRange = parseContentRange(headers['content-range'])
      if (
        contentRange == null ||
        (contentRange.end != null &&
          (contentRange.end <= contentRange.start ||
            (contentRange.size != null && contentRange.end > contentRange.size)))
      ) {
        // We don't support caching responses with invalid content-range...
        return super.onHeaders(statusCode, headers, resume)
      }
      if (this.#key.method === 'HEAD') {
        // A HEAD response delivers no body, so we never receive the byte
        // window Content-Range describes — storing it would fail the store's
        // body-length validation.
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
        if (key === '*') {
          // RFC 9111 §4.1: a Vary field containing '*' never matches.
          return super.onHeaders(statusCode, headers, resume)
        }
        // Record every selecting header, using a null sentinel when it was
        // absent from the request. RFC 9111 §4.1: absent-vs-present is a
        // mismatch, so an empty vary object must NOT act as a wildcard that
        // matches requests which later supply the header. headerValueEquals
        // treats null/absent as equal only to another null/absent.
        vary[key] = this.#key.headers[key] ?? null
      }
    }

    const ttl = cacheControlDirectives.immutable
      ? 31556952
      : Number(cacheControlDirectives['s-maxage'] ?? cacheControlDirectives['max-age'])
    if (!ttl || !Number.isFinite(ttl) || ttl <= 0) {
      return super.onHeaders(statusCode, headers, resume)
    }

    // RFC 9111 §4.2.3: a response relayed by an upstream/shared cache may
    // already be partway through its freshness lifetime. Subtract the
    // advertised Age so we don't over-extend the TTL and serve stale content.
    const age = Number(headers.age)
    const lifetime = Math.min(ttl, this.#maxEntryTTL) - (Number.isFinite(age) && age > 0 ? age : 0)
    if (lifetime <= 0) {
      // Already stale on arrival — not worth caching.
      return super.onHeaders(statusCode, headers, resume)
    }

    const start = contentRange ? contentRange.start : 0
    // HEAD never delivers a body, so a Content-Length must not drive the
    // stored byte window (end). Storing end = contentLength with an empty body
    // would fail the store's body-length validation and emit error-level log
    // spam on every cacheable HEAD response.
    const end = contentRange ? contentRange.end : this.#key.method === 'HEAD' ? 0 : contentLength

    if (end == null || end - start <= this.#maxEntrySize) {
      const cachedAt = Date.now()
      this.#value = {
        body: [],
        start,
        end,
        deleteAt: cachedAt + lifetime * 1e3,
        statusCode,
        statusMessage: '',
        headers,
        cacheControlDirectives,
        etag: isEtagUsable(headers.etag) ? headers.etag : '',
        vary,
        cachedAt,
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

  const rawCacheControl = opts?.headers?.['cache-control']
  const cacheControlDirectives = parseCacheControl(rawCacheControl) ?? {}
  // cache-control-parser does not recognise 'only-if-cached', so check the raw string.
  const onlyIfCached =
    typeof rawCacheControl === 'string' && rawCacheControl.includes('only-if-cached')

  // RFC 9111 Section 5.4: Pragma: no-cache should be treated as
  // Cache-Control: no-cache when Cache-Control is absent.
  if (rawCacheControl == null && opts?.headers?.pragma === 'no-cache') {
    cacheControlDirectives['no-cache'] = true
  }

  if (cacheControlDirectives['no-transform']) {
    // Do nothing. We don't transform requests...
  }

  if (
    // != null: 'max-age=0' parses to 0 (falsy) but still demands revalidation.
    cacheControlDirectives['max-age'] != null ||
    cacheControlDirectives['no-cache'] ||
    cacheControlDirectives['stale-if-error'] != null ||
    // cache-control-parser does not recognise 'max-stale'/'min-fresh', so
    // check the raw string like we do for 'only-if-cached'.
    (typeof rawCacheControl === 'string' &&
      (rawCacheControl.includes('max-stale') || rawCacheControl.includes('min-fresh')))
  ) {
    // TODO (fix): Support all cache control directives...
    return dispatch(opts, handler)
  }

  const store =
    opts.cache.store ?? (DEFAULT_STORE ??= new SqliteCacheStore({ location: ':memory:' }))

  // TODO (fix): enable range requests

  // Build the key the same way for lookups and stores: makeCacheKey
  // stringifies the origin (e.g. URL objects), so using raw opts on the get
  // path while the set path normalizes would make the cache permanently miss.
  const key = undici.util.cache.makeCacheKey(opts)

  let entry
  try {
    entry = store.get(key)
  } catch (err) {
    if (err.message === 'database is locked') {
      // Database is busy. We don't bother trying again...
      opts.logger?.debug({ err }, 'failed to get cache entry')
    } else {
      opts.logger?.error({ err }, 'failed to get cache entry')
    }
  }

  // RFC 9111 Section 3.5: A shared cache must not use a cached response to a
  // request with Authorization unless the response includes a public directive.
  if (entry && opts.headers?.authorization && !entry.cacheControlDirectives?.public) {
    entry = undefined
  }

  // RFC 9110 Section 13: Evaluate conditional request headers against cached entry.
  // typeof guards: duplicated conditional headers arrive as arrays — treat
  // them as non-matching and bypass to origin rather than crashing.
  if (entry && opts.headers?.['if-none-match']) {
    if (
      typeof opts.headers['if-none-match'] === 'string' &&
      entry.etag &&
      weakMatch(opts.headers['if-none-match'], entry.etag)
    ) {
      return serveFromCache(
        { statusCode: 304, headers: entry.headers, cachedAt: entry.cachedAt },
        opts,
        handler,
      )
    }
    // Etag didn't match — bypass to origin.
    entry = undefined
  } else if (entry && opts.headers?.['if-modified-since']) {
    const lastModified = entry.headers?.['last-modified']
    if (
      typeof opts.headers['if-modified-since'] === 'string' &&
      lastModified &&
      new Date(lastModified) <= new Date(opts.headers['if-modified-since'])
    ) {
      return serveFromCache(
        { statusCode: 304, headers: entry.headers, cachedAt: entry.cachedAt },
        opts,
        handler,
      )
    }
    // No last-modified or modified since — bypass to origin.
    entry = undefined
  }

  if (
    opts.headers?.['if-match'] ||
    opts.headers?.['if-unmodified-since'] ||
    opts.headers?.['if-range']
  ) {
    // TODO (fix): evaluate these conditional headers against cached entry.
    return dispatch(opts, handler)
  }

  if (!entry && !onlyIfCached) {
    return dispatch(
      opts,
      cacheControlDirectives['no-store']
        ? handler
        : new CacheHandler(key, {
            maxEntrySize: opts.cache.maxEntrySize,
            maxEntryTTL: opts.cache.maxEntryTTL,
            store,
            logger: opts.logger,
            handler,
          }),
    )
  }

  return serveFromCache(entry ?? { statusCode: 504 }, opts, handler)
}

function serveFromCache(entry, opts, handler) {
  const { statusCode, trailers, body } = entry

  let headers = entry.headers
  if (entry.cachedAt != null) {
    // RFC 9111 §5.1: every response served from cache must carry an Age header
    // reflecting time spent in this cache plus any age it arrived with —
    // otherwise downstream caches treat it as fresh-from-origin.
    // getFastNow has 1s resolution — Age is whole seconds, so that's enough.
    const residentAge = Math.max(0, Math.floor((getFastNow() - entry.cachedAt) / 1000))
    const originAge = Number(headers?.age)
    const age = Number.isFinite(originAge) && originAge > 0 ? originAge + residentAge : residentAge
    headers = { ...headers, age: `${age}` }
  }

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
 * RFC 9110 Section 8.8.3.2: Weak comparison — two etags match if their
 * opaque-tags match, ignoring the W/ prefix.
 *
 * @param {string} ifNoneMatch - The If-None-Match header value (may contain multiple etags)
 * @param {string} etag - The cached etag
 * @returns {boolean}
 */
function weakMatch(ifNoneMatch, etag) {
  if (ifNoneMatch === '*') {
    return true
  }

  const normalize = (tag) => (tag.startsWith('W/') ? tag.slice(2) : tag)
  const cached = normalize(etag)

  for (const raw of ifNoneMatch.split(',')) {
    if (normalize(raw.trim()) === cached) {
      return true
    }
  }

  return false
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
