import { SqliteCacheStore, assertCacheKey, makeValueUrl } from './sqlite-cache-store.js'

/**
 * Hashes a URL to a shard index. FNV-1a 32-bit over the UTF-16 code units,
 * followed by a murmur3-style finalizer so the low bits used by the modulo
 * are well mixed. Deliberately seedless: every process that opens the same
 * location with the same shard count must route a URL to the same shard.
 *
 * @param {string} url
 * @param {number} shards
 * @returns {number}
 */
function shardIndex(url, shards) {
  let h = 0x811c9dc5
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) % shards
}

/**
 * Shards a SqliteCacheStore across multiple SQLite databases by URL hash.
 *
 * SQLite (WAL mode) allows a single writer per database, so when several
 * processes or worker threads share one on-disk cache they serialize on the
 * write lock and can drop batches on SQLITE_BUSY. Splitting the keyspace into
 * `shards` independent databases (4 by default) gives each shard its own
 * write lock: concurrent writers only contend when they happen to flush the
 * same shard, and each flush transaction is proportionally smaller.
 *
 * Shard databases are stored as `<location>.<index>-<count>` (e.g.
 * `cache.db.0-4` … `cache.db.3-4`); `:memory:` gives every shard its own
 * private in-memory database. Encoding the count in the filename keeps
 * routing schemes disjoint: a process opening the same location with a
 * different shard count (e.g. during a rolling reconfiguration) gets a
 * fresh file set instead of sharing files with an incompatible URL→shard
 * mapping — otherwise a delete-by-URL invalidation issued under one count
 * could miss an entry that a writer under another count left in a file both
 * counts happen to use. All requests for a given URL — every method, vary
 * variant and byte range — hash to the same shard, so per-URL semantics
 * (supersede, RFC 9111 delete-by-URL invalidation) are unaffected by
 * sharding.
 *
 * `maxSize` is the budget for the whole store and is divided evenly across
 * the shards. Changing the shard count therefore starts from an empty
 * cache; the previous count's files are orphaned — never opened, grown or
 * gc'd again — and can be deleted manually. Each shard registers itself for
 * the process-level `nxt:offPeak` / `nxt:clearCache` broadcasts just like a
 * standalone SqliteCacheStore.
 */
export class SqliteShardedCacheStore {
  /**
   * @type {SqliteCacheStore[]}
   */
  #stores

  #closed = false

  /**
   * @param {{ location?: string, shards?: number, maxSize?: number, db?: Record<string, unknown> } | undefined} opts
   */
  constructor(opts) {
    const shards = opts?.shards ?? 4
    if (!Number.isInteger(shards) || shards < 1) {
      throw new TypeError(`expected opts.shards to be a positive integer, got ${shards}`)
    }

    const location = opts?.location ?? ':memory:'
    const maxSize = opts?.maxSize ?? 256 * 1024 * 1024

    // Divide the total budget so the per-shard budgets sum to exactly maxSize.
    // Math.ceil would overshoot the caller's requested total by up to shards-1;
    // instead floor it and spread the remainder one unit at a time across the
    // first shards. maxSize=0 (which the base store treats as "unlimited")
    // stays 0 for every shard.
    const baseMaxSize = Math.floor(maxSize / shards)
    const extraMaxSize = maxSize % shards

    this.#stores = []
    try {
      for (let i = 0; i < shards; i++) {
        this.#stores.push(
          new SqliteCacheStore({
            ...opts,
            location: location === ':memory:' ? location : `${location}.${i}-${shards}`,
            maxSize: baseMaxSize + (i < extraMaxSize ? 1 : 0),
          }),
        )
      }
    } catch (err) {
      // Don't leak database handles of already-opened shards when a later
      // shard fails to open (missing directory, disk full, ...).
      for (const store of this.#stores) {
        try {
          store.close()
        } catch {
          // closing best-effort; the constructor error is the one that matters
        }
      }
      throw err
    }
  }

  get shards() {
    return this.#stores.length
  }

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   * @returns {SqliteCacheStore}
   */
  #shard(key) {
    assertCacheKey(key)
    return this.#stores[shardIndex(makeValueUrl(key), this.#stores.length)]
  }

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   * @returns {(import('undici-types/cache-interceptor.d.ts').default.GetResult & { body?: Buffer }) | undefined}
   */
  get(key) {
    return this.#shard(key).get(key)
  }

  /**
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheValue & { body: null | Buffer | Array<Buffer>, start: number, end: number }} value
   */
  set(key, value) {
    this.#shard(key).set(key, value)
  }

  /**
   * Invalidates every stored response for the key's URI in its shard.
   * Exposed only when the underlying SqliteCacheStore provides delete() —
   * the static block below removes it otherwise — so the wrapper's surface
   * mirrors the base store's capability (the cache interceptor
   * feature-detects store.delete) whichever change lands first.
   *
   * @param {import('undici-types/cache-interceptor.d.ts').default.CacheKey} key
   */
  delete(key) {
    this.#shard(key).delete(key)
  }

  static {
    if (typeof SqliteCacheStore.prototype.delete !== 'function') {
      Reflect.deleteProperty(this.prototype, 'delete')
    }
  }

  gc() {
    for (const store of this.#stores) {
      store.gc()
    }
  }

  clear() {
    for (const store of this.#stores) {
      store.clear()
    }
  }

  close() {
    // Idempotent: the base store's close() throws on a second call (it closes
    // an already-closed DatabaseSync), so guard here to make double-close a
    // safe no-op. This lets callers register an unconditional cleanup (e.g. a
    // test teardown) alongside an explicit close without swallowing errors.
    if (this.#closed) {
      return
    }
    this.#closed = true

    // Close every shard even if one throws so the rest don't leak; rethrow
    // the first failure afterwards.
    let err
    for (const store of this.#stores) {
      try {
        store.close()
      } catch (e) {
        err ??= e
      }
    }
    if (err) {
      throw err
    }
  }
}
