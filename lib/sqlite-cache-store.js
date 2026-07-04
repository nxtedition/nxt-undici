import { DatabaseSync } from 'node:sqlite'
import { parseRangeHeader, getFastNow } from './utils.js'

// Bump version when the URL key format or schema changes to invalidate old caches.
const VERSION = 11

// Registry of live stores so process-level broadcasts (nxt:offPeak,
// nxt:clearCache) can reach them. Stores are held via WeakRef so that a store
// dropped without close() is not pinned forever (together with its open
// DatabaseSync handle and page cache) — GC can still collect it. close()
// remains the recommended, deterministic cleanup path.
/** @type {Set<WeakRef<SqliteCacheStore>>} */
const stores = new Set()

// Removes a collected store's WeakRef entry once the store has been GC'd.
// The callback runs after the store is already gone, so it must not (and
// cannot) touch the store or its DatabaseSync — the native handle has its own
// lifecycle and is released by GC/process exit. This only drops bookkeeping.
const registry = new FinalizationRegistry((ref) => {
  stores.delete(ref)
})

/**
 * @param {(store: SqliteCacheStore) => void} fn
 */
function forEachStore(fn) {
  for (const ref of stores) {
    const store = ref.deref()
    if (store === undefined) {
      stores.delete(ref)
    } else {
      fn(store)
    }
  }
}

{
  const offPeakBC = new BroadcastChannel('nxt:offPeak')
  offPeakBC.unref()
  offPeakBC.onmessage = () => {
    forEachStore((store) => store.gc())
  }
}

{
  const clearCacheBC = new BroadcastChannel('nxt:clearCache')
  clearCacheBC.unref()
  clearCacheBC.onmessage = () => {
    forEachStore((store) => store.clear())
  }
}

/**
 * Synchronous get/set/delete cache store backed by node:sqlite. Note: this is
 * NOT undici's stream-based CacheStore interface (createWriteStream); the
 * cache interceptor in this package drives it directly.
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
   * @type {number}
   */
  #dbTimeout = 20

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

  /**
   * @type {import('node:sqlite').StatementSync}
   */
  #deleteByUrlQuery

  /**
   * @type {import('node:sqlite').StatementSync}
   */
  #supersedeFullQuery

  /**
   * @type {import('node:sqlite').StatementSync}
   */
  #supersede206Query

  #insertBatch = []
  #insertSeq = 0
  #closed = false

  /**
   * @type {WeakRef<SqliteCacheStore>}
   */
  #ref

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.SqliteCacheStoreOpts & { maxSize?: number } | undefined} opts
   */
  constructor(opts) {
    this.#dbTimeout = opts?.db?.timeout ?? this.#dbTimeout
    this.#db = new DatabaseSync(opts?.location ?? ':memory:', {
      ...opts?.db,
      timeout: this.#dbTimeout,
    })

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
        staleAt INTEGER NOT NULL,
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

    // Drop tables left behind by previous schema versions. gc(), clear() and
    // the SQLITE_FULL eviction only ever touch the current version's table, so
    // after a VERSION bump the old table's pages would otherwise stay allocated
    // to its b-tree forever while max_page_count caps the whole file — new
    // inserts hit SQLITE_FULL almost immediately and eviction frees nothing.
    // Dropping returns the pages to SQLite's freelist, which subsequent inserts
    // reuse, so no VACUUM is needed. SQLite drops the table's indexes and its
    // sqlite_sequence row along with it.
    try {
      // LIKE is only a coarse pre-filter; the regexp restricts matches to
      // digit-only version suffixes so user tables sharing the prefix (e.g.
      // "cacheInterceptorVBackup") in a shared database file are never dropped.
      const staleTables = this.#db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cacheInterceptorV%'`,
        )
        .all()
        .filter(
          ({ name }) =>
            /^cacheInterceptorV\d+$/.test(name) && name !== `cacheInterceptorV${VERSION}`,
        )
      if (staleTables.length > 0) {
        this.#db.exec('BEGIN')
        try {
          for (const { name } of staleTables) {
            // name comes from sqlite_master; quote it defensively anyway.
            this.#db.exec(`DROP TABLE IF EXISTS "${String(name).replaceAll('"', '""')}"`)
          }
          this.#db.exec('COMMIT')
        } catch (err) {
          try {
            this.#db.exec('ROLLBACK')
          } catch {
            // already rolled back automatically
          }
          throw err
        }
      }
    } catch (err) {
      // A failed cleanup must not brick construction — the current version's
      // table still works, the stale one just keeps occupying pages.
      process.emitWarning(err)
    }

    this.#getValuesQuery = this.#db.prepare(`
      SELECT
        id,
        body,
        start,
        end,
        staleAt,
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
        id DESC
    `)

    this.#insertValueQuery = this.#db.prepare(`
      INSERT INTO cacheInterceptorV${VERSION} (
        url,
        method,
        body,
        start,
        end,
        staleAt,
        deleteAt,
        statusCode,
        statusMessage,
        headers,
        etag,
        cacheControlDirectives,
        vary,
        cachedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.#deleteExpiredValuesQuery = this.#db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE deleteAt <= ?`,
    )

    // Evict the N entries expiring soonest. Used on SQLITE_FULL to free space
    // without requiring expired entries to already exist.
    this.#evictQuery = this.#db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE id IN (SELECT id FROM cacheInterceptorV${VERSION} ORDER BY deleteAt ASC LIMIT ?)`,
    )

    // RFC 9111 §4.4 invalidation: a successful unsafe request invalidates every
    // stored response for the URI, across methods and vary variants.
    this.#deleteByUrlQuery = this.#db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE url = ?`,
    )

    // Supersede queries: a newly flushed row replaces prior rows for the same
    // representation so hot keys don't accumulate dead duplicates until gc.
    // Receipt order (insertion order), NOT cachedAt, decides who wins — the
    // same semantics as upstream undici's update-in-place set(). cachedAt is
    // backdated by the corrected initial age (RFC 9111 §4.2.3), so a
    // replacement fetched through a relay advertising a large Age (or a 304
    // freshening with a skewed origin Date) can carry an OLDER cachedAt than
    // the stale row it replaces; keying supersede or the read sort on
    // cachedAt would let the stale row win every read, forever. `vary IS ?`
    // is NULL-safe and compares the serialized-JSON text, deterministic
    // because both sides are produced by the same CacheHandler code path
    // (key order = Vary header order). A new full (non-206) representation
    // supersedes all prior full ones regardless of byte window; a 206 only
    // supersedes the exact same window so distinct partials coexist, and
    // never a 200 row (matchesValue routes range and non-range requests to
    // different rows).
    this.#supersedeFullQuery = this.#db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE url = ? AND method = ? AND vary IS ? AND statusCode != 206`,
    )
    this.#supersede206Query = this.#db.prepare(
      `DELETE FROM cacheInterceptorV${VERSION} WHERE url = ? AND method = ? AND vary IS ? AND statusCode = 206 AND start = ? AND end = ?`,
    )

    this.#ref = new WeakRef(this)
    stores.add(this.#ref)
    // The store itself doubles as the unregister token so close() can drop
    // the registry entry deterministically.
    registry.register(this, this.#ref, this)
  }

  gc() {
    if (this.#closed) {
      return
    }

    try {
      this.#db.exec('PRAGMA busy_timeout = 1000')
      this.#deleteExpiredValuesQuery.run(getFastNow())
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      this.#db.exec('PRAGMA optimize')
    } catch (err) {
      process.emitWarning(err)
    } finally {
      try {
        this.#db.exec(`PRAGMA busy_timeout = ${this.#dbTimeout}`)
      } catch (err) {
        process.emitWarning(err)
      }
    }
  }

  clear() {
    this.#insertBatch.length = 0

    if (this.#closed) {
      return
    }

    try {
      this.#db.exec('PRAGMA busy_timeout = 1000')
      this.#db.exec(`DELETE FROM cacheInterceptorV${VERSION}`)
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      this.#db.exec('PRAGMA optimize')
    } catch (err) {
      process.emitWarning(err)
    } finally {
      try {
        this.#db.exec(`PRAGMA busy_timeout = ${this.#dbTimeout}`)
      } catch (err) {
        process.emitWarning(err)
      }
    }
  }

  close() {
    stores.delete(this.#ref)
    registry.unregister(this)
    // Drain the entire batch synchronously before closing. A plain #flush()
    // only commits one time-budget slice and reschedules the rest via
    // setImmediate; that deferred flush would see #closed and discard the
    // remainder, silently losing entries. Pass final=true to ignore the
    // budget and flush everything in one pass while #closed is still false.
    if (this.#insertBatch.length > 0) {
      this.#flush(true)
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

    const entry = {
      // Monotonic per-store sequence used only to break cachedAt ties in
      // #findValue (newest write wins). Not persisted — #flush ignores it.
      seq: this.#insertSeq++,
      url: makeValueUrl(key),
      method: key.method,
      body,
      start: value.start,
      end: value.end,
      staleAt: value.staleAt,
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
    }

    // Coalesce within the pending batch: a stampede of identical misses would
    // otherwise commit N identical rows. Receipt order wins (see the
    // #supersede* query comments): the entry being added supersedes every
    // pending entry for the same representation.
    for (let i = this.#insertBatch.length - 1; i >= 0; i--) {
      const other = this.#insertBatch[i]
      if (
        other.url === entry.url &&
        other.method === entry.method &&
        other.vary === entry.vary &&
        (entry.statusCode !== 206
          ? other.statusCode !== 206
          : other.statusCode === 206 && other.start === entry.start && other.end === entry.end)
      ) {
        this.#insertBatch.splice(i, 1)
      }
    }

    this.#insertBatch.push(entry)
  }

  /**
   * Invalidates every stored response for the key's URI (RFC 9111 §4.4) —
   * across methods and vary variants. Pending batched inserts for the URI are
   * dropped as well: a batch entry flushed after the DELETE would otherwise
   * resurrect the invalidated response. Note this only covers THIS process's
   * batch — with a shared on-disk store, another process's in-flight batch
   * can still transiently resurrect an entry (bounded by its ~10ms flush
   * slice); cross-process invalidation is inherently best-effort.
   *
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   */
  delete(key) {
    assertCacheKey(key)

    if (this.#closed) {
      return
    }

    const url = makeValueUrl(key)

    for (let i = this.#insertBatch.length - 1; i >= 0; i--) {
      if (this.#insertBatch[i].url === url) {
        this.#insertBatch.splice(i, 1)
      }
    }

    this.#deleteByUrlQuery.run(url)
  }

  #flush = (final = false) => {
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
              staleAt,
              deleteAt,
              statusCode,
              statusMessage,
              headers,
              etag,
              cacheControlDirectives,
              vary,
              cachedAt,
            } = this.#insertBatch[n++]
            // Supersede prior rows for the same representation (see the
            // #supersede* query comments) inside the same transaction, so a
            // re-cache replaces instead of accumulating.
            if (statusCode === 206) {
              this.#supersede206Query.run(url, method, vary, start, end)
            } else {
              this.#supersedeFullQuery.run(url, method, vary)
            }
            this.#insertValueQuery.run(
              url,
              method,
              body,
              start,
              end,
              staleAt,
              deleteAt,
              statusCode,
              statusMessage,
              headers,
              etag,
              cacheControlDirectives,
              vary,
              cachedAt,
            )
            if (!final && (n & 0xf) === 0 && performance.now() - startTime > 10) {
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

    if (this.#insertBatch.length === 0) {
      // Fast path: rows arrive sorted (cachedAt DESC, id DESC) and there are
      // no pending batch entries to merge, so fetch only the newest candidate.
      // This covers misses and first-row hits (the overwhelmingly common
      // cases) with a single row materialized — re-cached duplicates of a hot
      // key would otherwise all be read including their blobs. Only when the
      // newest row doesn't match (vary variant, range/206 mismatch) do we
      // fall through to scan the full candidate set.
      const value = this.#getValuesQuery.get(url, method, requestedStart, now)
      if (value === undefined) {
        return undefined
      }
      if (matchesValue(value, range, headers)) {
        return value
      }
    }

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

    // Most recently WRITTEN representation wins — receipt order, not
    // cachedAt (see the #supersede* query comments: cachedAt is backdated by
    // the corrected initial age, so a fresher write can carry an older
    // cachedAt). Pending batch entries (tagged with a monotonic seq) are
    // always newer than any flushed DB row, and within each source a higher
    // seq/id wins.
    if (values.length > 1) {
      values.sort((a, b) => {
        const aBatch = a.seq != null
        const bBatch = b.seq != null
        if (aBatch !== bBatch) {
          return aBatch ? -1 : 1
        }
        if (aBatch) {
          return b.seq - a.seq
        }
        return (b.id ?? 0) - (a.id ?? 0)
      })
    }

    for (const value of values) {
      if (matchesValue(value, range, headers)) {
        return value
      }
    }

    return undefined
  }
}

/**
 * @param {SqliteStoreValue} value
 * @param {import('./utils.js').RangeHeader | undefined} range
 * @param {Record<string, string | string[]> | undefined} headers
 * @returns {boolean}
 */
function matchesValue(value, range, headers) {
  // TODO (fix): Allow full and partial match?
  if (range && (range.start !== value.start || range.end !== value.end)) {
    return false
  }

  // A request without a Range header asks for the full representation, so
  // a stored 206 partial (e.g. content-range bytes 0-4/100, which the SQL
  // `start <= 0` filter does not exclude) must not be served verbatim.
  if (!range && value.statusCode === 206) {
    return false
  }

  if (value.vary) {
    const vary = JSON.parse(value.vary)

    for (const header in vary) {
      if (!headerValueEquals(headers?.[header], vary[header])) {
        return false
      }
    }
  }

  return true
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

  // A single-element array and the bare scalar denote the same logical header
  // value (e.g. 'gzip' vs ['gzip']); normalize so an inconsistently-shaped
  // selecting header doesn't cause an avoidable cache miss.
  const a = Array.isArray(lhs) && lhs.length === 1 ? lhs[0] : lhs
  const b = Array.isArray(rhs) && rhs.length === 1 ? rhs[0] : rhs

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false
    }

    return a.every((x, i) => x === b[i])
  }

  return a === b
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
    // Batch entries (tagged with seq) must be copied: value.body is the exact
    // Buffer still queued for flushing, so a consumer mutating the served body
    // could corrupt the bytes about to be written. DB rows are safe to alias —
    // node:sqlite allocates a fresh Uint8Array per read, so wrap it zero-copy.
    body: value.body
      ? value.seq != null
        ? Buffer.from(value.body)
        : Buffer.from(value.body.buffer, value.body.byteOffset, value.body.byteLength)
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
