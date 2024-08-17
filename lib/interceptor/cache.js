import assert from 'node:assert'
import { DecoratorHandler, parseHeaders, parseCacheControl } from '../utils.js'
import { DatabaseSync } from 'node:sqlite' // --experimental-sqlite
import * as BJSON from 'buffer-json'

class CacheHandler extends DecoratorHandler {
  #handler
  #store
  #key
  #opts
  #value

  constructor({ key, handler, store, opts }) {
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
    if (statusCode !== 307 || statusCode !== 200) {
      return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
    }

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
          expires: Date.now() + ttl,
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
      const reqHeaders = this.#opts
      const resHeaders = parseHeaders(this.#value.data.rawHeaders)

      // Early return if Vary = *, uncacheable.
      if (resHeaders.vary === '*') {
        return this.#handler.onComplete(rawTrailers)
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
    .map((key) => [key, reqHeaders[key] ?? ''])
    .filter(([, val]) => val)
}

export class CacheStore {
  #database

  #insertquery
  #getQuery
  #purgeQuery

  #size = 0
  #maxSize = 128e9

  constructor(location = ':memory:', opts) {
    // TODO (fix): Validate args...

    this.#maxSize = opts.maxSize ?? this.#maxSize
    this.#database = new DatabaseSync(location)

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS cacheInterceptor(
        key TEXT,
        data TEXT,
        vary TEXT,
        size INTEGER,
        expires INTEGER
      ) STRICT
    `)

    this.#insertquery = this.#database.prepare(
      'INSERT INTO cacheInterceptor (key, data, vary, size, expires) VALUES (?, ?, ?, ?, ?)',
    )

    this.#getQuery = this.#database.prepare(
      'SELECT * FROM cacheInterceptor WHERE key = ? AND expires > ? ',
    )

    this.#purgeQuery = this.#database.prepare('DELETE FROM cacheInterceptor WHERE expires < ?')

    this.#maybePurge()
  }

  set(key, { data, vary, size, expires }) {
    this.#insertquery.run(key, JSON.stringify(data), BJSON.stringify(vary), size, expires)

    this.#size += size
    this.#maybePurge()
  }

  get(key) {
    return this.#getQuery.all(key, Date.now()).map(({ data, vary, size, expires }) => ({
      data: BJSON.parse(data),
      vary: JSON.parse(vary),
      size: parseInt(size), // TODO (fix): Is parseInt necessary?
      expires: parseInt(expires), // TODO (fix): Is parseInt necessary?
    }))
  }

  close() {
    this.#database.close()
  }

  #maybePurge() {
    if (this.#size == null || this.#size > this.#maxSize) {
      this.#purgeQuery.run(Date.now())
      this.#size = this.#database.exec('SELECT SUM(size) FROM cacheInterceptor')[0].values[0][0]
    }
  }
}

function findEntryByHeaders(entries, reqHeaders) {
  return entries?.find(
    (entry) => entry.vary?.every(([key, val]) => reqHeaders?.headers[key] === val) ?? true,
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

  const entries = store.get(key) ?? (opts.method === 'HEAD' ? store.get(`GET:${opts.path}`) : null)

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
