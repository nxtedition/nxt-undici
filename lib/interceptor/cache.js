import assert from 'node:assert'
import { DecoratorHandler, parseHeaders, parseCacheControl } from '../utils.js'
import { DatabaseSync } from 'node:sqlite' // --experimental-sqlite

class CacheHandler extends DecoratorHandler {
  #handler
  #store
  #key
  #opts
  #value = null

  constructor({ key, handler, store, opts = [] }) {
    super(handler)

    this.#key = key
    this.#handler = handler
    this.#store = store
    this.#opts = opts
  }

  onConnect(abort) {
    this.#value = null

    return this.#handler.onConnect(abort)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
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
            body: [],
          },
          size:
            (rawHeaders?.reduce((xs, x) => xs + x.length, 0) ?? 0) +
            (statusMessage?.length ?? 0) +
            64,
          expires: Date.now() + ttl, // in ms!
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
  }

  onComplete(rawTrailers) {
    if (this.#value) {
      const resHeaders = parseHeaders(this.#value.data.rawHeaders)

      // Early return if Vary = *, uncacheable.
      if (resHeaders.vary === '*') {
        return this.#handler.onComplete(rawTrailers)
      }

      const reqHeaders = this.#opts

      // If Range header present, assume that the response varies based on Range.
      if (reqHeaders.headers?.range) {
        resHeaders.vary += ', Range'
      }

      this.#value.data.rawTrailers = rawTrailers
      this.#value.size = this.#value.size
        ? this.#value.size + rawTrailers?.reduce((xs, x) => xs + x.length, 0)
        : 0

      this.#value.vary = formatVaryData(resHeaders, reqHeaders)

      this.#store.set(this.#key, this.#value)
    }
    return this.#handler.onComplete(rawTrailers)
  }
}

function formatVaryData(resHeaders, reqHeaders) {
  return resHeaders.vary
    ?.split(',')
    .map((key) => key.trim().toLowerCase())
    .map((key) => [key, reqHeaders[key] ?? reqHeaders.headers[key]])
    .filter(([_key, val]) => val)
}

export class CacheStore {
  constructor() {
    this.database = null
    this.init()
  }

  init() {
    this.database = new DatabaseSync('file:memdb1?mode=memory&cache=shared')

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS cacheInterceptor(
        key TEXT,
        data TEXT,
        vary TEXT,
        size INTEGER,
        expires INTEGER
      ) STRICT
    `)
  }

  set(key, entry) {
    if (!this.database) {
      throw new Error('Database not initialized')
    }

    entry.data = JSON.stringify(entry.data)
    entry.vary = JSON.stringify(entry.vary)

    const insert = this.database.prepare(
      'INSERT INTO cacheInterceptor (key, data, vary, size, expires) VALUES (?, ?, ?, ?, ?)',
    )

    insert.run(key, entry.data, entry.vary, entry.size, entry.expires)

    this.purge()
  }

  get(key) {
    if (!this.database) {
      throw new Error('Database not initialized')
    }
    this.purge()
    const query = this.database.prepare(
      'SELECT * FROM cacheInterceptor WHERE key = ? AND expires > ? ',
    )
    const rows = query.all(key, Date.now())
    rows.map((i) => {
      i.data = JSON.parse(i.data)
      i.vary = JSON.parse(i.vary)
      i.data = {
        ...i.data,
        // JSON.parse doesn't convert a Buffer object back to a Buffer object once it has been stringified.
        body: this.#convertToBuffer(i.data.body),
        rawHeaders: this.#convertToBuffer(i.data.rawHeaders),
        rawTrailers: this.#convertToBuffer(i.data.rawTrailers),
      }
      return i
    })

    return rows
  }

  purge() {
    const query = this.database.prepare('DELETE FROM cacheInterceptor WHERE expires < ?')
    query.run(Date.now())
  }

  deleteAll() {
    const query = this.database.prepare('DELETE FROM cacheInterceptor')
    query.run()
  }

  #convertToBuffer(bufferArray) {
    if (Array.isArray(bufferArray) && bufferArray.length > 0) {
      return bufferArray.map((ba) => {
        return typeof ba === 'object' ? Buffer.from(ba.data) : ba
      })
    }
    return []
  }
}

/*
  Sort entries by number of vary headers in descending order, because
  we need to compare the most complex response to the request first.
  A cached response with an empty ´vary´ field will otherwise win every time.
*/
function sortEntriesByVary(entries) {
  entries.sort((a, b) => {
    const lengthA = a.vary ? a.vary.length : 0
    const lengthB = b.vary ? b.vary.length : 0
    return lengthB - lengthA
  })
}

function findEntryByHeaders(entries, reqHeaders) {
  sortEntriesByVary(entries)

  return entries?.find(
    (entry) =>
      entry.vary?.every(([key, val]) => {
        return reqHeaders?.headers[key] === val
      }) ?? true,
  )
}

const DEFAULT_CACHE_STORE = new CacheStore()

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

  opts.host = opts.host ?? new URL(opts.origin).host

  if (!opts.headers) {
    opts.headers = {}
  }

  // idea: use DEFAULT_CACHE_STORE by default if 'cache' not specified, since the cache interceptor was already specified to be used.
  const store = opts.cache === true ? DEFAULT_CACHE_STORE : opts.cache

  if (!store) {
    throw new Error(`Cache store not provided.`)
  }

  const key = `${opts.method}:${opts.path}`

  const entries = (store.get(key) ?? opts.method === 'HEAD') ? store.get(`GET:${opts.path}`) : null

  const entry = findEntryByHeaders(entries, opts)

  if (entry) {
    const { statusCode, statusMessage, rawHeaders, rawTrailers, body } = entry.data
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
    return dispatch(opts, new CacheHandler({ handler, store, key, opts }))
  }
}
