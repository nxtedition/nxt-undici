import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert'
import { parseRangeHeader, getFastNow } from './utils.js'

const VERSION = 7

/**
 * @typedef {import('undici-types/cache-interceptor.d.ts').default.CacheStore} CacheStore
 * @implements {CacheStore}
 *
 * @typedef {{
 *  id: Readonly<number>,
 *  body?: Uint8Array
 *  start: number
 *  end: number
 *  statusCode: number
 *  statusMessage: string
 *  headers?: string
 *  vary?: string
 *  etag?: string
 *  cacheControlDirectives?: string
 *  cachedAt: number
 *  staleAt: number
 *  deleteAt: number
 * }} SqliteStoreValue
 */
export class SqliteCacheStore {
  /**
   * @type {import('node:sqlite').DatabaseSync}
   */
  #db

  /**
   * @type {import('node:sqlite').StatementSync}
   */
  #getValuesQuery

  /**
   * @type {import('node:sqlite').StatementSync}
   */
  #insertValueQuery

  /**
   * @type {import('node:sqlite').StatementSync}
   */
  #deleteExpiredValuesQuery

  /**
   * @type {number}
   */
  #deleteExpiredValuesTime = getFastNow()

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.SqliteCacheStoreOpts & { maxEntryCount?: number } | undefined} opts
   */
  constructor(opts) {
    this.#db = new DatabaseSync(opts?.location ?? ':memory:', { timeout: 100, ...opts?.db })

    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = memory;
      PRAGMA optimize;

      CREATE TABLE IF NOT EXISTS cacheInterceptorV${VERSION} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        method TEXT NOT NULL,
        body BUF NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        deleteAt INTEGER NOT NULL,
        statusCode INTEGER NOT NULL,
        statusMessage TEXT NOT NULL,
        headers TEXT NULL,
        cacheControlDirectives TEXT NULL,
        etag TEXT NULL,
        vary TEXT NULL,
        cachedAt INTEGER NOT NULL,
        staleAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_getValuesQuery ON cacheInterceptorV${VERSION}(url, method, start, deleteAt);
      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_deleteExpiredValuesQuery ON cacheInterceptorV${VERSION}(deleteAt);
    `)

    this.#getValuesQuery = this.#db.prepare(`
      SELECT
        id,
        body,
        deleteAt,
        statusCode,
        statusMessage,
        headers,
        etag,
        cacheControlDirectives,
        vary,
        cachedAt,
        staleAt
      FROM cacheInterceptorV${VERSION}
      WHERE
        url = ?
        AND method = ?
        AND start <= ?
      ORDER BY
        deleteAt ASC
    `)

    this.#insertValueQuery = this.#db.prepare(`
      INSERT INTO cacheInterceptorV${VERSION} (
        url,
        method,
        body,
        start,
        end,
        deleteAt,
        statusCode,
        statusMessage,
        headers,
        etag,
        cacheControlDirectives,
        vary,
        cachedAt,
        staleAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.#deleteExpiredValuesQuery = this.#db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE deleteAt <= ?`,
    )
  }

  close() {
    this.#db.close()
  }

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   * @returns {(import('undici-types/cache-interceptor.d.ts').default.GetResult & { body?: Buffer }) | undefined}
   */
  get(key) {
    assertCacheKey(key)

    this.#prune()

    const value = this.#findValue(key)
    return value ? makeResult(value) : undefined
  }

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheValue & { body: null | Buffer | Array<Buffer>, start: number, end: number }} value
   */
  set(key, value) {
    assertCacheKey(key)
    assertCacheValue(value)

    const body = Array.isArray(value.body) ? Buffer.concat(value.body) : value.body

    assert(Number.isFinite(value.start))
    assert(Number.isFinite(value.end))
    assert(!body || body?.byteLength === value.end - value.start)

    this.#prune()

    this.#insertValueQuery.run(
      makeValueUrl(key),
      key.method,
      body,
      value.start,
      value.end,
      value.deleteAt ?? Date.now() + 3600e3,
      value.statusCode,
      value.statusMessage,
      value.headers ? JSON.stringify(value.headers) : null,
      value.etag ? value.etag : null,
      value.cacheControlDirectives ? JSON.stringify(value.cacheControlDirectives) : null,
      value.vary ? JSON.stringify(value.vary) : null,
      value.cachedAt,
      value.staleAt,
    )
  }

  #prune() {
    const now = getFastNow()
    if (now > this.#deleteExpiredValuesTime) {
      this.#deleteExpiredValuesQuery.run(now)
      this.#deleteExpiredValuesTime = now + 60e3
    }
  }

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   * @param {boolean} [canBeExpired=false]
   * @returns {SqliteStoreValue | undefined}
   */
  #findValue(key, canBeExpired = false) {
    const { headers, method } = key

    if (Array.isArray(headers?.range)) {
      return undefined
    }

    const range = parseRangeHeader(headers?.range)

    if (range === undefined) {
      return undefined
    }

    /**
     * @type {SqliteStoreValue[]}
     */
    const values = this.#getValuesQuery.all(makeValueUrl(key), method, range?.start ?? 0)

    if (values.length === 0) {
      return undefined
    }

    const now = getFastNow()
    for (const value of values) {
      if (now >= value.deleteAt && !canBeExpired) {
        return undefined
      }

      let matches = true

      // TODO (fix): Allow full and partial match?
      if (range && (range.start !== value.start || range.end !== value.end)) {
        continue
      }

      if (value.vary) {
        const vary = JSON.parse(value.vary)

        for (const header in vary) {
          if (!headerValueEquals(headers?.[header], vary[header])) {
            matches = false
            break
          }
        }
      }

      if (matches) {
        return value
      }
    }

    return undefined
  }
}

/**
 * @param {string|string[]|null|undefined} lhs
 * @param {string|string[]|null|undefined} rhs
 * @returns {boolean}
 */
function headerValueEquals(lhs, rhs) {
  if (lhs == null && rhs == null) {
    return true
  }

  if ((lhs == null && rhs != null) || (lhs != null && rhs == null)) {
    return false
  }

  if (Array.isArray(lhs) && Array.isArray(rhs)) {
    if (lhs.length !== rhs.length) {
      return false
    }

    return lhs.every((x, i) => x === rhs[i])
  }

  return lhs === rhs
}

/**
 * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
 * @returns {string}
 */
function makeValueUrl(key) {
  return `${key.origin}/${key.path}`
}

function makeResult(value) {
  return {
    body: value.body
      ? Buffer.from(value.body.buffer, value.body.byteOffset, value.body.byteLength)
      : undefined,
    statusCode: value.statusCode,
    statusMessage: value.statusMessage,
    headers: value.headers ? JSON.parse(value.headers) : undefined,
    etag: value.etag ? value.etag : undefined,
    vary: value.vary ? JSON.parse(value.vary) : undefined,
    cacheControlDirectives: value.cacheControlDirectives
      ? JSON.parse(value.cacheControlDirectives)
      : undefined,
    cachedAt: value.cachedAt,
    staleAt: value.staleAt,
    deleteAt: value.deleteAt,
  }
}

function printType(val) {
  return val == null ? 'null' : typeof val === 'object' ? val.constructor.name : typeof val
}

/**
 * @param {any} key
 */
function assertCacheKey(key) {
  if (typeof key !== 'object' || key == null) {
    throw new TypeError(`expected key to be object, got ${typeof printType(key)} [${key}]`)
  }

  for (const property of ['origin', 'method', 'path']) {
    if (typeof key[property] !== 'string') {
      throw new TypeError(
        `expected key.${property} to be string, got ${printType(key[property])} [${key[property]}]`,
      )
    }
  }

  if (key.headers !== undefined && typeof key.headers !== 'object') {
    throw new TypeError(
      `expected headers to be object, got ${typeof printType(key)} [${key.headers}]`,
    )
  }
}

/**
 * @param {any} value
 */
function assertCacheValue(value) {
  if (typeof value !== 'object' || value == null) {
    throw new TypeError(`expected value to be object, got ${typeof printType(value)}`)
  }

  for (const property of ['statusCode', 'cachedAt', 'staleAt', 'deleteAt']) {
    if (typeof value[property] !== 'number') {
      throw new TypeError(
        `expected value.${property} to be number, got ${printType(value[property])} [${value[property]}]`,
      )
    }
  }

  if (typeof value.statusMessage !== 'string') {
    throw new TypeError(
      `expected value.statusMessage to be string, got ${printType(value.statusMessage)} [${value.statusMessage}]`,
    )
  }

  if (value.headers != null && typeof value.headers !== 'object') {
    throw new TypeError(
      `expected value.rawHeaders to be object, got ${printType(value.headers)} [${value.headers}]`,
    )
  }

  if (value.vary !== undefined && typeof value.vary !== 'object') {
    throw new TypeError(
      `expected value.vary to be object, got ${printType(value.vary)} [${value.vary}]`,
    )
  }

  if (value.etag !== undefined && typeof value.etag !== 'string') {
    throw new TypeError(
      `expected value.etag to be string, got ${printType(value.etag)} [${value.etag}]`,
    )
  }
}
