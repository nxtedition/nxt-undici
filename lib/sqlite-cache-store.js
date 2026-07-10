import { DatabaseSync } from 'node:sqlite'
import { parseRangeHeader, getFastNow } from './utils.js'

// Bump version when the URL key format or schema changes to invalidate old caches.
const VERSION = 12
const CACHE_TABLE = `cacheInterceptorV${VERSION}`

class SqliteCacheSchemaError extends Error {
  code = 'ERR_SQLITE_CACHE_SCHEMA_MISMATCH'

  constructor(tables) {
    super(
      `SqliteCacheStore: incompatible cache schema; expected ${CACHE_TABLE}, found ${tables.join(', ')}`,
    )
    this.name = 'SqliteCacheSchemaError'
  }
}

// Cache files are never migrated or destructively repaired in place. A table
// from any other cache schema version means the file belongs to an incompatible
// package version; fail before creating the current table or changing data.
// Errors reading sqlite_master (including SQLITE_NOTADB/SQLITE_CORRUPT) are
// likewise allowed to propagate unchanged.
function assertCompatibleSchema(db) {
  const incompatible = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cacheInterceptorV%'`,
    )
    .all()
    .map(({ name }) => name)
    .filter((name) => /^cacheInterceptorV\d+$/.test(name) && name !== CACHE_TABLE)
    .sort()

  if (incompatible.length > 0) {
    throw new SqliteCacheSchemaError(incompatible)
  }
}

// Synchronous bounded sleep for the constructor's SQLITE_BUSY retry (the
// constructor has no event loop to yield to). Atomics.wait on a throwaway
// SharedArrayBuffer is the only spin-free sync sleep available on the main
// thread.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms)
}

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
  #maxEntrySize
  #maxEntryTTL

  /**
   * @type {WeakRef<SqliteCacheStore>}
   */
  #ref

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.SqliteCacheStoreOpts & { maxSize?: number } | undefined} opts
   */
  constructor(opts) {
    this.#dbTimeout = opts?.db?.timeout ?? this.#dbTimeout
    this.#maxEntrySize = opts?.maxEntrySize
    this.#maxEntryTTL = opts?.maxEntryTTL
    this.#db = new DatabaseSync(opts?.location ?? ':memory:', {
      ...opts?.db,
      timeout: this.#dbTimeout,
    })

    try {
      assertCompatibleSchema(this.#db)
    } catch (err) {
      // Construction failed: close the handle, preserve the database byte for
      // byte, and surface the original corruption/incompatibility error. If
      // close() also throws, don't let it mask the original — suppress it into
      // a SuppressedError so both are retained, with the schema error as the
      // primary `.error`.
      try {
        this.#db.close()
      } catch (closeErr) {
        throw new SuppressedError(
          err,
          closeErr,
          'Failed to close database after schema validation error',
        )
      }
      throw err
    }

    const maxSize = opts?.maxSize ?? 256 * 1024 * 1024
    // page_size is a persistent property fixed when the file's first page is
    // written; a pre-existing DB may not use 4096. max_page_count is the one
    // pragma denominated in pages, so compute it from the file's real page
    // size — hard-coding 4096 would cap a 1024-byte-page file at maxSize/4
    // (constant premature-FULL eviction churn) and a 8192 one at 2x maxSize.
    const pageSize = this.#withBusyRetry(() => this.#db.prepare('PRAGMA page_size').get().page_size)
    // Multi-process cold start on a shared DB file: another process's flush
    // transaction or wal_checkpoint can hold the write lock while we run the
    // schema DDL, surfacing SQLITE_BUSY (sometimes immediately — DDL does not
    // reliably reach the busy handler, so a larger busy_timeout alone does
    // not help). Construction is the one path whose failure is fatal rather
    // than best-effort; retry it, bounded, like gc()/clear() raise their own
    // budgets for lock-contending maintenance.
    this.#withBusyRetry(() =>
      this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = OFF;
      PRAGMA wal_autocheckpoint = 10000;
      PRAGMA cache_size = -${Math.ceil(maxSize / 1024 / 8)};
      PRAGMA mmap_size = ${maxSize};
      PRAGMA max_page_count = ${Math.ceil(maxSize / pageSize)};
      PRAGMA optimize;

      CREATE TABLE IF NOT EXISTS cacheInterceptorV${VERSION} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        method TEXT NOT NULL,
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
        cachedAt INTEGER NOT NULL,
        -- body is deliberately the LAST column: the lookup filters candidate
        -- rows on start/deleteAt and vary, and any column stored after a
        -- large blob would force SQLite to walk the blob's overflow pages
        -- just to test a row it may then reject.
        body BLOB NULL
      );

      -- (url, method) with the implicit rowid tail satisfies the lookup's
      -- ORDER BY id DESC via a backward index scan, so .get() truly stops at
      -- the newest candidate. Adding more columns (the old start/deleteAt
      -- suffix) breaks that ordering and forces a temp B-tree sort that
      -- materializes every candidate row — blobs included — per lookup.
      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_getValuesQuery ON cacheInterceptorV${VERSION}(url, method);
      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_deleteExpiredValuesQuery ON cacheInterceptorV${VERSION}(deleteAt);
      -- Covers the supersede-on-flush DELETEs (#supersedeFullQuery /
      -- #supersede206Query), whose predicate is url+method+vary (+statusCode,
      -- and start/end for 206) — so a re-cache supersedes via an index seek
      -- instead of scanning every row for a hot url+method with many Vary
      -- variants or partial windows.
      CREATE INDEX IF NOT EXISTS idx_cacheInterceptorV${VERSION}_supersedeQuery ON cacheInterceptorV${VERSION}(url, method, vary, statusCode, start, end);
    `),
    )

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

  // Constructor-only: bounded synchronous retry on SQLITE_BUSY (~1s worst
  // case). Everything else in the store stays best-effort/never-throw.
  #withBusyRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn()
      } catch (err) {
        if (err?.errcode !== 5 /* SQLITE_BUSY */ || attempt >= 50) {
          throw err
        }
        sleepSync(20)
      }
    }
  }

  // Read by CacheHandler/RevalidationHandler as the per-store default when
  // the per-request opts.cache.maxEntrySize/maxEntryTTL are not set
  // (`maxEntrySize ?? store.maxEntrySize ?? DEFAULT`). undefined when the
  // constructor option was omitted, so the package default applies.
  get maxEntrySize() {
    return this.#maxEntrySize
  }

  get maxEntryTTL() {
    return this.#maxEntryTTL
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
    if (this.#closed) {
      return
    }
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

    // Both branches copy: Buffer.concat snapshots chunk arrays, and a bare
    // Buffer is copied because the caller may keep delivering the same bytes
    // to a user handler while they sit in the pending batch (makeResult makes
    // the mirror-image copy in the read direction).
    const body = Array.isArray(value.body)
      ? Buffer.concat(value.body)
      : value.body != null
        ? Buffer.from(value.body)
        : value.body

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
      // staleAt column is NOT NULL; default to deleteAt when the caller omits
      // it (pre-v11 value shape) — matches this package's staleAt === deleteAt.
      staleAt: value.staleAt ?? value.deleteAt,
      deleteAt: value.deleteAt,
      statusCode: value.statusCode,
      statusMessage: value.statusMessage,
      headers: value.headers ? JSON.stringify(value.headers) : null,
      etag: value.etag != null ? value.etag : null,
      cacheControlDirectives: value.cacheControlDirectives
        ? JSON.stringify(value.cacheControlDirectives)
        : null,
      // Canonical text: the supersede DELETEs, the in-batch coalescing and
      // #findValue's batch merge all compare this serialized form byte-wise,
      // but equivalent selector maps can arrive shaped differently (304
      // freshening rebuilds the map from the revalidating request: key order
      // may differ, a single-element array selector matches a scalar via
      // headerValueEquals). Canonicalizing keeps "same variant" one row
      // instead of accumulating dead duplicates until deleteAt.
      vary: value.vary ? JSON.stringify(canonicalVary(value.vary)) : null,
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

    // Best-effort like every other write path (set/gc/clear warn instead of
    // throwing): a transient DB error here — e.g. SQLITE_BUSY on a shared
    // file-backed store — would otherwise propagate into the interceptor's
    // response path. The in-memory batch purge above already happened, so a
    // failed row delete can at worst resurrect until deleteAt, which is the
    // same best-effort bound cross-process invalidation already has.
    try {
      this.#deleteByUrlQuery.run(url)
    } catch (err) {
      process.emitWarning(err)
    }
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
          if (this.#db.isTransaction) {
            // A previous failed flush whose ROLLBACK itself failed (or a
            // foreign statement) left the connection mid-transaction. BEGIN
            // would then throw "cannot start a transaction within a
            // transaction" and every subsequent flush would drop its batch —
            // a permanent silent write outage. Clear it first so one bad
            // transaction can't wedge the store.
            this.#db.exec('ROLLBACK')
          }
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
          // an open transaction; without it the next BEGIN would throw. On
          // SQLITE_FULL, SQLite rolls the transaction back automatically —
          // isTransaction is then false and no ROLLBACK is issued (this
          // replaces the old blind try/catch and its TODO about checking the
          // error type). A ROLLBACK that itself fails is surfaced as a
          // warning; the pre-BEGIN guard above recovers the connection on the
          // next flush instead of silently dropping every future batch.
          if (this.#db.isTransaction) {
            try {
              this.#db.exec('ROLLBACK')
            } catch (err) {
              process.emitWarning(err)
            }
          }

          if (err?.errcode === 13 /* SQLITE_FULL */ && retryCount < 3) {
            try {
              this.#evictQuery.run(256)
            } catch (evictErr) {
              // The eviction itself failed (cross-process SQLITE_BUSY on a
              // shared file, genuinely full disk): retrying cannot make
              // progress. Drop the attempted entries like the
              // retries-exhausted path below — leaving the batch pinned
              // would make the setImmediate reschedule at the bottom
              // busy-loop forever, one warning per iteration.
              process.emitWarning(evictErr)
              this.#insertBatch.splice(0, n || this.#insertBatch.length)
              throw err
            }
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

/**
 * Canonical form of a Vary selector map for serialization: keys sorted,
 * single-element array values collapsed to their scalar (the equivalence
 * headerValueEquals already applies when matching). Semantically identical
 * maps thus always serialize to identical JSON text.
 */
function canonicalVary(vary) {
  // Null prototype, like every header/selector map in the cache: a selector
  // literally named `__proto__` assigned onto a plain `{}` would hit the
  // Object.prototype setter and silently vanish from the serialized map —
  // turning the stored Vary into a match-everything wildcard.
  const out = Object.create(null)
  for (const name of Object.keys(vary).sort()) {
    const val = vary[name]
    out[name] = Array.isArray(val) && val.length === 1 ? val[0] : val
  }
  return out
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

  for (const property of ['statusCode', 'cachedAt', 'deleteAt']) {
    if (typeof value[property] !== 'number') {
      throw new TypeError(
        `expected value.${property} to be number, got ${printType(value[property])} [${value[property]}]`,
      )
    }
  }

  // staleAt is optional for backward compatibility: pre-v11 callers of the
  // public SqliteCacheStore.set() omit it, and set() defaults it to deleteAt
  // (this package's staleAt === deleteAt semantics). Validate the type only
  // when supplied.
  if (value.staleAt !== undefined && typeof value.staleAt !== 'number') {
    throw new TypeError(
      `expected value.staleAt to be number, got ${printType(value.staleAt)} [${value.staleAt}]`,
    )
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
