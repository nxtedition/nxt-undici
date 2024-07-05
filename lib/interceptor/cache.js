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
    // console.log('onHeaders, headers:')
    // console.log(headers)

    if (statusCode !== 307) {
      return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
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
            rawHeaders,
            rawTrailers: null,
            body: [], // Why is the body emptied? When we cache it again it won't have a body.
          },
          size:
            (rawHeaders?.reduce((xs, x) => xs + x.length, 0) ?? 0) +
            (statusMessage?.length ?? 0) +
            64,
          ttl: ttl * 1e3,
        }
      }
    }

    return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
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
    /* 
      Is 'this.#handler.onData' the previous dispatcher in the chain, e.g. 'redirect'?
      And in 'redirect.onData(chunk)' it once again calls 'this.#handler.onData(chunk)'. 
      Would that be 'responseVerify.onData(chunk)'?
    */
  }

  onComplete(rawTrailers, opts) {
    console.log('onComplete, value: ' + this.#value)
    console.log('onComplete, opts:')
    console.log(opts)

    if (this.#value) {
      this.#value.data.rawTrailers = rawTrailers
      this.#value.size += rawTrailers?.reduce((xs, x) => xs + x.length, 0) ?? 0

      console.log('OnComplete, cache store is being set to: ')
      console.log([this.#key, this.#value.data, { ttl: this.#value.ttl, size: this.#value.size }])

      /*
        Why are we setting the cache with the same data as the entry we fetched earlier 
        from the very same cache?

        We have the request data in the `opts` variable, but where is the response data that we need to cache?
        Is the response cached somewhere else?

        We have the headers we need from the request. But we need the response data to know the vary-header
        and we also need it to store the response.
      */
      this.#store.set(this.#key, this.#value.data, { ttl: this.#value.ttl, size: this.#value.size })
    }
    return this.#handler.onComplete(rawTrailers, opts)
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
    console.log('setting cache with values:')
    console.log({ key, value, opts })

    this.cache.set(key, value, opts)
  }

  get(key) {
    return this.cache.get(key)
  }
}

function makeKey(opts) {
  // NOTE: Ignores headers...
  // return `${opts.origin}:${opts.method}:${opts.path}`
  return `${opts.method}:${opts.path}`
}

function varyHeadersMatchRequest(varyHeaders, requestHeaders) {
  // const headersToString = []
  // for(const header of cachedRawHeaders){
  //   headersToString.push(header.toString())
  // }

  // const varyHeaders = headersToString.reduce((acc, cur, index, arr) => {
  //   if (index % 2 === 0) {
  //     acc[cur] = arr[index + 1];
  //   }
  //   return acc;
  // }, {});

  // Early return if `varyHeaders` is null/undefined or an empty object
  if (!varyHeaders || Object.keys(varyHeaders).length === 0) {
    return true
  }
  const varyKeys = Object.keys(varyHeaders)
  // All vary headers must match request headers, return true/false.
  return varyKeys.every((varyKey) => varyHeaders[varyKey] === requestHeaders[varyKey])
}

function findEntryByHeaders(entries, requestHeaders) {
  return entries.find((entry) => varyHeadersMatchRequest(entry, requestHeaders))
}

const DEFAULT_CACHE_STORE = new CacheStore({ maxSize: 128 * 1024, maxEntrySize: 1024 })

export default (opts) => (dispatch) => (opts, handler) => {
  console.log('cache dispatcher:')
  console.log(dispatch)
  console.log('opts:')
  console.log(opts)
  console.log('handler:')
  console.log(handler)

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
  console.log('getting key: ' + key)
  let entries = store.get(key)

  console.log('Found entries in cache: ')
  console.log(entries)

  // if key with method:'HEAD' didn't yield results, retry with method:'GET'
  if (entries.length === 0 && opts.method === 'HEAD') {
    key = makeKey({ ...opts, method: 'GET' })
    entries = store.get(key)
    // value = {data: {headers: {vary: {origin: "www.google.com"}}}
  }

  // Find an entry that matches the request, if any
  const entry = findEntryByHeaders(entries, opts)

  if (entry) {
    const { statusCode, statusMessage, rawHeaders, rawTrailers, body } = entry
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
        handler.onComplete(rawTrailers, opts)
      } else {
        handler.onComplete([], opts)
      }
    } catch (err) {
      handler.onError(err)
    }

    return true
  } else {
    return dispatch(opts, new CacheHandler({ handler, store, key: makeKey(opts) }))
  }
}
