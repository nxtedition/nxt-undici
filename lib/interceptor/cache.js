import undici from '@nxtedition/undici'
import { DecoratorHandler, parseCacheControl, parseContentRange } from '../utils.js'

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

    super.onConnect((reason) => {
      // TODO (fix): Can we cache partial results?
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

    if (statusCode === 206 && !parseContentRange(headers['content-range'])) {
      // We don't support caching range responses without content-range...
      return super.onHeaders(statusCode, headers, resume)
    }

    if (statusCode === 206) {
      // TODO (fix): enable range requests
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
      etag: isEtagUsable(headers.etag) ? headers.etag : '',
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
  const entry = store.get(opts)

  // let entry
  // if (opts.headers.range) {
  //   const range = parseRangeHeader(opts.headers.range)
  //   if (!range) {
  //     // Invalid range header...
  //     return dispatch(opts, handler)
  //   }

  //   // TODO (perf): This is not optimal as all range bodies will be loaded...
  //   // Make sure it only returns valid ranges by passing/parsing content range...
  //   const entries = store.getAll(opts)

  //   for (const x of entries) {
  //     const { statusCode, headers, body } = x

  //     if (!body) {
  //       continue
  //     }

  //     let contentRange
  //     if (statusCode === 200) {
  //       // TODO (fix): Implement this...
  //       // contentRange = { start: 0, end: body.byteLength }
  //       // x = {
  //       //   ...x,
  //       //   headers: {
  //       //     ...x,
  //       //     'content-md5': undefined
  //       //     // TODO (fix): What other headers need to be modified? accept-ranges? etag?
  //       //   }
  //       // }
  //     } else if (statusCode === 206) {
  //       contentRange = parseContentRange(headers?.['content-range'])
  //     }

  //     if (!contentRange) {
  //       continue
  //     }

  //     if (contentRange.start === range.start && contentRange.end === range.end) {
  //       entry = x
  //       break
  //     }

  //     // TODO (fix): Implement this...
  //     // const start = 0
  //     // const end = contentRange.end - contentRange.start
  //     // x = {
  //     //   ...x,
  //     //   body: body.subarray(start, end),
  //     //   headers: {
  //     //     ...headers,
  //     //     'content-range': `bytes ${start}-${end - 1}/${contentRange.size ?? '*'}`
  //     //     'content-md5': undefined
  //     //      // TODO (fix): What other headers need to be modified? etag?
  //     //   }
  //     // }
  //     // TODO (fix): Pick best entry... i.e. what ever fullfills most of the range
  //   }
  // } else {
  //   entry = store.get(opts)

  //   // TODO (fix): store.get is not optimal as it can return partial (206) responses.
  //   // Make sure it only returns valid statusCodes.
  //   if (entry?.statusCode === 206) {
  //     return dispatch(opts, handler)
  //   }
  // }

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

  // Dump body...
  opts.body?.on('error', () => {}).resume()

  try {
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
