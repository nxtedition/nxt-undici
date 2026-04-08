import { DatabaseSync } from 'node:sqlite'
import { parseRangeHeader, getFastNow } from './utils.js'

// Bump version when the URL key format or schema changes to invalidate old caches.
const VERSION = 10

/** @typedef {{ purgeStale: () => void } } */
const stores = new Set()

{
  const offPeakBC = new BroadcastChannel('nxt:offPeak')
  offPeakBC.unref()
  offPeakBC.onmessage = () => {
    for (const store of stores) {
      store.purgeStale()
    }
  }
}

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
   * @type {import('node:sqlite').StatementSync}
   */
  #evictQuery

  #insertBatch = []
  #closed = false

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.SqliteCacheStoreOpts & { maxSize?: number } | undefined} opts
   */
  constructor(opts) {
    this.#db = new DatabaseSync(opts?.location ?? ':memory:', { timeout: 20, ...opts?.db })

    const maxSize = opts?.maxSize ?? 256 * 1024 * 1024
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = OFF;
      PRAGMA wal_autocheckpoint = 10000;
      PRAGMA cache_size = -${Math.ceil(maxSize / 1024 / 8)};
      PRAGMA mmap_size = ${maxSize};
      PRAGMA max_page_count = ${Math.ceil(maxSize / 4096)};
      PRAGMA optimize;

      CREATE TABLE IF NOT EXISTS cacheInterceptorV${VERSION} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        method TEXT NOT NULL,
        body BLOB NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        deleteAt INTEGER NOT NULL,
        statusCode INTEGER NOT NULL,
        statusMessage TEXT NOT NULL,
        headers TEXT NULL,
        cacheControlDirectives TEXT NULL,
        etag TEXT NULL,
        vary TEXT NULL,
        cachedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_getValuesQuery ON cacheInterceptorV${VERSION}(url, method, start, deleteAt);
      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_deleteExpiredValuesQuery ON cacheInterceptorV${VERSION}(deleteAt);
    `)

    this.#getValuesQuery = this.#db.prepare(`
      SELECT
        id,
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
        cachedAt
      FROM cacheInterceptorV${VERSION}
      WHERE
        url = ?
        AND method = ?
        AND start <= ?
        AND deleteAt > ?
      ORDER BY
        cachedAt DESC
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
        cachedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.#deleteExpiredValuesQuery = this.#db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE deleteAt <= ?`,
    )

    // Evict the N entries expiring soonest. Used on SQLITE_FULL to free space
    // without requiring expired entries to already exist.
    this.#evictQuery = this.#db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE id IN (SELECT id FROM cacheInterceptorV${VERSION} ORDER BY deleteAt ASC LIMIT ?)`,
    )

    stores.add(this)
  }

  purgeStale() {
    try {
      this.#deleteExpiredValuesQuery.run(getFastNow())
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      this.#db.exec('PRAGMA optimize')
    } catch (err) {
      process.emitWarning(err)
    }
  }

  close() {
    stores.delete(this)
    if (this.#insertBatch.length > 0) {
      this.#flush()
    }
    this.#closed = true
    this.#db.close()
  }

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   * @returns {(import('undici-types/cache-interceptor.d.ts').default.GetResult & { body?: Buffer }) | undefined}
   */
  get(key) {
    assertCacheKey(key)

    if (this.#closed) {
      return undefined
    }

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

    if (typeof value.start !== 'number') {
      throw new TypeError(
        `expected value.start to be a number, got ${printType(value.start)} [${value.start}]`,
      )
    }
    if (!Number.isFinite(value.start) || value.start < 0) {
      throw new RangeError(
        `expected value.start to be a non-negative finite number, got ${value.start}`,
      )
    }
    if (typeof value.end !== 'number') {
      throw new TypeError(
        `expected value.end to be a number, got ${printType(value.end)} [${value.end}]`,
      )
    }
    if (!Number.isFinite(value.end) || value.end < value.start) {
      throw new RangeError(
        `expected value.end to be a finite number >= start (${value.start}), got ${value.end}`,
      )
    }
    if (body && body.byteLength !== value.end - value.start) {
      throw new RangeError(
        `body length ${body.byteLength} does not match end - start (${value.end} - ${value.start} = ${value.end - value.start})`,
      )
    }

    if (this.#closed) {
      return
    }

    if (this.#insertBatch.length === 0) {
      setImmediate(this.#flush)
    }

    this.#insertBatch.push({
      url: makeValueUrl(key),
      method: key.method,
      body,
      start: value.start,
      end: value.end,
      deleteAt: value.deleteAt,
      statusCode: value.statusCode,
      statusMessage: value.statusMessage,
      headers: value.headers ? JSON.stringify(value.headers) : null,
      etag: value.etag != null ? value.etag : null,
      cacheControlDirectives: value.cacheControlDirectives
        ? JSON.stringify(value.cacheControlDirectives)
        : null,
      vary: value.vary ? JSON.stringify(value.vary) : null,
      cachedAt: value.cachedAt,
    })
  }

  #flush = () => {
    if (this.#insertBatch.length === 0) return
    if (this.#closed) {
      this.#insertBatch.length = 0
      return
    }
    try {
      const startTime = performance.now()
      for (let retryCount = 0; true; retryCount++) {
        let n = 0
        try {
          this.#db.exec('BEGIN')
          while (n < this.#insertBatch.length) {
            const {
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
            } = this.#insertBatch[n++]
            this.#insertValueQuery.run(
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
            )
            if ((n & 0xf) === 0 && performance.now() - startTime > 10) {
              break
            }
          }
          this.#db.exec('COMMIT')
          this.#insertBatch.splice(0, n)
          break
        } catch (err) {
          // ROLLBACK is required: a failed statement leaves the connection with
          // an open transaction; without it the next BEGIN would throw.
          // On SQLITE_FULL, SQLite automatically rolls back the transaction, so
          // the explicit ROLLBACK may fail with "no transaction is active" — ignore it.
          try {
            this.#db.exec('ROLLBACK')
          } catch {
            // already rolled back automatically
            // TODO (fix): Check that the error is what we expect (something like "no transaction is active")...
          }

          if (err?.errcode === 13 /* SQLITE_FULL */ && retryCount < 3) {
            this.#evictQuery.run(256)
          } else {
            // If BEGIN failed (n=0) clear the whole batch to avoid an infinite
            // retry loop. If an INSERT/COMMIT failed, only clear the entries
            // that were part of the attempted transaction.
            this.#insertBatch.splice(0, n || this.#insertBatch.length)
            throw err
          }
        }
      }
    } catch (err) {
      process.emitWarning(err)
    }

    if (this.#insertBatch.length > 0) {
      // If we weren't able to flush the entire batch within the time limit, schedule another flush.
      setImmediate(this.#flush)
    }
  }

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   * @returns {SqliteStoreValue | undefined}
   */
  #findValue(key) {
    const { headers, method } = key

    if (Array.isArray(headers?.range)) {
      return undefined
    }

    const range = parseRangeHeader(headers?.range)

    if (range === null) {
      return undefined
    }

    const url = makeValueUrl(key)
    const now = getFastNow()
    const requestedStart = range?.start ?? 0

    /**
     * @type {SqliteStoreValue[]}
     */
    const values = this.#getValuesQuery.all(url, method, requestedStart, now)

    for (const entry of this.#insertBatch) {
      if (
        entry.url === url &&
        entry.method === method &&
        entry.start <= requestedStart &&
        entry.deleteAt > now
      ) {
        values.push(entry)
      }
    }

    if (values.length === 0) {
      return undefined
    }

    values.sort((a, b) => b.cachedAt - a.cachedAt)

    for (const value of values) {
      // TODO (fix): Allow full and partial match?
      if (range && (range.start !== value.start || range.end !== value.end)) {
        continue
      }

      if (value.vary) {
        const vary = JSON.parse(value.vary)
        let matches = true

        for (const header in vary) {
          if (!headerValueEquals(headers?.[header], vary[header])) {
            matches = false
            break
          }
        }

        if (!matches) {
          continue
        }
      }

      return value
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
  return `${key.origin}${key.path}`
}

function makeResult(value) {
  return {
    body: value.body
      ? Buffer.from(value.body.buffer, value.body.byteOffset, value.body.byteLength)
      : undefined,
    statusCode: value.statusCode,
    statusMessage: value.statusMessage,
    headers: value.headers ? JSON.parse(value.headers) : undefined,
    etag: value.etag != null ? value.etag : undefined,
    vary: value.vary ? JSON.parse(value.vary) : undefined,
    cacheControlDirectives: value.cacheControlDirectives
      ? JSON.parse(value.cacheControlDirectives)
      : undefined,
    cachedAt: value.cachedAt,
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
    throw new TypeError(`expected key to be object, got ${printType(key)} [${key}]`)
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
      `expected headers to be object, got ${printType(key.headers)} [${key.headers}]`,
    )
  }
}

/**
 * @param {any} value
 */
function assertCacheValue(value) {
  if (typeof value !== 'object' || value == null) {
    throw new TypeError(`expected value to be object, got ${printType(value)}`)
  }

  for (const property of ['statusCode', 'cachedAt', 'deleteAt']) {
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
