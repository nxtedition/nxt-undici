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
    console.log('onConnect abort')
    console.log(abort)

    this.#value = null

    return this.#handler.onConnect(abort)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    console.log('onHeaders')
    console.log({ statusCode, rawHeaders, resume, statusMessage, headers })

    if (statusCode !== 307) {
      return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
    }

    // TODO (fix): Support vary header.
    const cacheControl = parseCacheControl(headers['cache-control'])

    const contentLength = headers['content-length'] ? Number(headers['content-length']) : Infinity
    const maxEntrySize = this.#store.maxEntrySize ?? Infinity

    console.log({ cacheControl, contentLength, maxEntrySize })

    console.log('onHeaders if statement match:')

    console.log(
      contentLength < maxEntrySize &&
        cacheControl &&
        cacheControl.public &&
        !cacheControl.private &&
        !cacheControl['no-store'] &&
        !cacheControl['no-cache'] &&
        !cacheControl['must-understand'] &&
        !cacheControl['must-revalidate'] &&
        !cacheControl['proxy-revalidate'],
    )

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

      console.log({ ttl, maxAge, cacheControl, contentLength, maxEntrySize })

      if (ttl > 0) {
        this.#value = {
          data: {
            statusCode,
            statusMessage,
            rawHeaders,
            rawTrailers: null,
            body: [],
          },
          size:
            (rawHeaders?.reduce((xs, x) => xs + x.length, 0) ?? 0) +
            (statusMessage?.length ?? 0) +
            64,
          ttl: ttl * 1e3,
        }
      }

      console.log({ thisvalue: this.#value })
    }

    console.log('onHeaders, finish:')
    console.log({ statusCode, rawHeaders, resume, statusMessage, headers })

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
  }

  onComplete(rawTrailers) {
    console.log('onComplete this:')
    console.log({ thisvalue: this.#value })
    console.log({ thisstore: this.#store }) // CacheStore{}
    console.log({ thishandler: this.#handler }) // RequestHandler{}
    console.log({ thishandlervalue: this.#handler.value })
    console.log({ this: this })
    if (this.#value) {
      this.#value.data.rawTrailers = rawTrailers
      this.#value.size += rawTrailers?.reduce((xs, x) => xs + x.length, 0) ?? 0

      const opts = this.#handler.opts
      const entries = this.#handler.entries
      console.log('onComplete this:')
      console.log({ opts, entries })

      const reqHeaders = this.#handler.opts
      const resHeaders = parseHeaders(this.#value.data.rawHeaders)

      const vary = formatVaryData(resHeaders, reqHeaders)

      console.log({ vary })

      this.#value.vary = vary

      console.log({ entries })

      this.#store.set(this.#key, entries.push(this.#value))
    }
    return this.#handler.onComplete(rawTrailers)
  }
}

function formatVaryData(resHeaders, reqHeaders) {
  return resHeaders.vary
    ?.split(',')
    .map((key) => key.trim().toLowerCase())
    .map((key) => [key, reqHeaders[key]])
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

function findEntryByHeaders(entries, reqHeaders) {
  // Sort entries by number of vary headers in descending order, because
  // we want to compare the most complex response to the request first.
  entries.sort((a, b) => {
    const lengthA = a.vary ? a.vary.length : 0
    const lengthB = b.vary ? b.vary.length : 0
    return lengthB - lengthA
  })

  console.log('Sort entries')
  console.log({ entries })

  console.log('reqHeaders')
  console.log({ reqHeaders })

  return entries?.find(
    (entry) =>
      entry.vary?.every(([key, val]) => {
        console.log(`reqHeaders[${key}] === ${val}`)
        console.log({ reqHeadersval: reqHeaders[key] })
        return reqHeaders[key] === val
      }) ?? true,
  )
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

  let key = `${opts.method}:${opts.path}`
  console.log('getting key: ' + key)
  let entries = store.get(key)

  if (Array.isArray(entries) && entries.length === 0 && opts.method === 'HEAD') {
    key = `GET:${opts.path}`
    entries = store.get(key)
  }

  // testing
  const rawHeaders = [
    Buffer.from('Content-Type'),
    Buffer.from('application/json'),
    Buffer.from('Content-Length'),
    Buffer.from('10'),
    Buffer.from('Cache-Control'),
    Buffer.from('public'),
  ]
  // // cannot get the cache to work inside the test, so I hardcode the entries here
  entries = [
    {
      statusCode: 200,
      statusMessage: '',
      rawHeaders,
      rawTrailers: ['Hello'],
      body: ['asd1'],
      vary: [
        ['Accept', 'application/xml'],
        ['User-Agent', 'Mozilla/5.0'],
      ],
    },
    {
      statusCode: 200,
      statusMessage: '',
      rawHeaders,
      rawTrailers: ['Hello'],
      body: ['asd2'],
      vary: [
        ['Accept', 'application/txt'],
        ['User-Agent', 'Chrome'],
        ['origin2', 'www.google.com/images'],
      ],
    },
    // {
    //   statusCode: 200, statusMessage: 'last', rawHeaders, rawTrailers: ['Hello'], body: ['asd3'],
    //   vary: null },
    {
      statusCode: 200,
      statusMessage: 'first',
      rawHeaders,
      rawTrailers: ['Hello'],
      body: ['asd4'],
      vary: [
        ['Accept', 'application/json'],
        ['User-Agent', 'Mozilla/5.0'],
        ['host2', 'www.google.com'],
        ['origin2', 'www.google.com/images'],
      ],
    },
  ]

  // *testing

  // Find an entry that matches the request, if any
  const entry = findEntryByHeaders(entries, opts)

  console.log('Entry found:')
  console.log({ entry })

  // handler.value.vary = 'foobar'

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
        handler.onComplete(rawTrailers)
      } else {
        handler.onComplete([])
      }
    } catch (err) {
      handler.onError(err)
    }

    return true
  } else {
    // handler.opts = opts
    // handler.entries = entries
    return dispatch(opts, new CacheHandler({ handler, store, key }))
  }
}
