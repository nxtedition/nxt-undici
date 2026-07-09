import { parseCacheControl } from '../../utils.js'
import { isHopByHop } from '../proxy.js'
import { CacheHandler } from './cache-handler.js'
import {
  DEFAULT_MAX_ENTRY_TTL,
  computeEntryTimes,
  determineAge,
  determineLifetime,
} from './freshness.js'
import { conditionalHeaders, isEtagUsable, parseVary } from './headers.js'
import { serveFromCache } from './serve.js'
import { cacheOptsOf } from './store.js'

const NOOP = () => {}

// RFC 5861 §4: the statuses that count as an "error" for stale-if-error are
// exactly 500, 502, 503 and 504. 501 (Not Implemented) and 505+ are NOT errors
// in this sense, so a `>= 500 && <= 504` range would wrongly include 501.
const STALE_IF_ERROR_STATUSES = new Set([500, 502, 503, 504])

// In-flight background stale-while-revalidate refreshes, so a hot stale key
// spawns one refresh, not a herd. Keyed per cache store (a WeakMap, so a
// discarded store's guard set is collected with it): the guard is only
// meaningful within a single store, and a module-global keyed by URL alone
// would let refreshes for unrelated stores block each other. Within a store
// the key also includes the selected Vary variant so distinct representations
// of the same URL don't share one refresh slot.
const backgroundRefreshes = new WeakMap()

/**
 * Stable, unambiguous serialization of a Vary selector map for use as part of
 * an in-flight refresh key: distinct representations of the same URL (e.g.
 * different Accept-Encoding) must not share one refresh slot. Sorted keys make
 * it order-independent; JSON keeps the null sentinel distinct from an empty
 * string value.
 */
function varyKey(vary) {
  if (!vary) {
    return ''
  }
  const names = Object.keys(vary).sort()
  return JSON.stringify(names.map((name) => [name, vary[name]]))
}

/**
 * Drives a conditional (revalidation) request to the origin for a stale
 * stored entry (RFC 9111 §4.3). Decision at response headers:
 * - 304: the entry is valid — freshen it (§4.3.4) and serve it.
 * - a 500/502/503/504 within the stale-if-error window (RFC 5861 §4's error
 *   statuses, incl. undici PR #5513's pre-response connection errors): discard
 *   the error and serve the stale entry.
 * - anything else: a real replacement — stream it through a CacheHandler to
 *   the user handler, storing it on the way.
 *
 * The user handler's response callbacks are DEFERRED until that decision, but
 * onConnect is forwarded eagerly with a bridging abort — the user (e.g. a
 * signal listener in request()) must be able to tear down the in-flight
 * conditional request; nothing below the cache observes opts.signal
 * mid-flight. Delivery paths re-invoke onConnect (serveFromCache / the pass
 * CacheHandler drive their own connect), which handlers in this pipeline
 * already tolerate — the retry interceptor re-connects the same handler on
 * every attempt.
 */
export class RevalidationHandler {
  #key
  #entry
  #store
  #logger
  #opts
  #cacheOpts
  #userHandler
  #allowStaleOnError
  #noStore
  #write
  #id
  #url
  #lookupMs
  /** @type {null | 'pass' | 'validated' | 'stale'} */
  #mode = null
  /** @type {CacheHandler | import('../../utils.js').DecoratorHandler | object | null} */
  #inner = null
  /** @type {((reason?: any) => void) | null} */
  #abort = null
  /** @type {Record<string, string | string[]> | null} */
  #headers304 = null
  #delivered = false
  #userAborted = false
  #userAbortReason = null

  constructor(
    key,
    entry,
    opts,
    { store, logger, handler, allowStaleOnError, noStore, cacheOpts, write, id, url, lookupMs },
  ) {
    this.#key = key
    this.#entry = entry
    this.#store = store
    this.#logger = logger
    this.#opts = opts
    this.#cacheOpts = cacheOpts
    this.#userHandler = handler
    this.#allowStaleOnError = allowStaleOnError
    this.#noStore = noStore ?? false
    // Trace context (null when tracing is off / for background refresh): the
    // eventual serveFromCache and pass-mode CacheHandler emit their docs with
    // it, so a synchronous revalidation traces like any other lookup/store.
    this.#write = write ?? null
    this.#id = id ?? null
    this.#url = url ?? null
    this.#lookupMs = lookupMs ?? null
  }

  onConnect(abort) {
    this.#abort = abort
    // Eager connect: hand the user a bridging abort so a caller abort (e.g.
    // a signal firing in request()) tears down the in-flight conditional
    // request instead of being silently ignored until the origin answers.
    this.#userHandler.onConnect((reason) => {
      if (!this.#delivered && !this.#userAborted) {
        this.#userAborted = true
        this.#userAbortReason = reason
        this.#abort?.(reason)
      }
    })
  }

  onUpgrade(statusCode, headers, socket) {
    // Upgrades are gated out before the cache interceptor engages; nothing to
    // do but not crash if one slips through.
    socket?.destroy?.()
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode < 200) {
      // Informational (1xx) interim responses — e.g. 103 Early Hints — are
      // not the revalidation answer; stay undecided and keep reading.
      return true
    }

    if (statusCode === 304) {
      this.#mode = 'validated'
      this.#headers304 = headers
      return true
    }

    if (this.#allowStaleOnError && STALE_IF_ERROR_STATUSES.has(statusCode)) {
      this.#mode = 'stale'
      // The decision to serve stale is already made — don't wait for the error
      // body to drain (it can be large and only adds latency/bandwidth).
      // Deliver the stale entry now and abort the in-flight request; the
      // resulting onError is suppressed by the #delivered guard.
      this.#deliver(this.#entry)
      this.#abort?.(new Error('stale-if-error: serving stale cached response'))
      return false
    }

    this.#mode = 'pass'
    // RFC 9111 §5.2.1.5: a request no-store forbids storing the replacement
    // response — stream it to the user handler without the CacheHandler wrap.
    this.#inner = this.#noStore
      ? this.#userHandler
      : new CacheHandler(this.#key, {
          ...this.#cacheOpts,
          store: this.#store,
          logger: this.#logger,
          handler: this.#userHandler,
          write: this.#write,
          id: this.#id,
          url: this.#url,
        })
    this.#inner.onConnect((reason) => this.#abort?.(reason))
    return this.#inner.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    return this.#mode === 'pass' ? this.#inner.onData(chunk) : true
  }

  onComplete(trailers) {
    if (this.#mode === 'pass') {
      return this.#inner.onComplete(trailers)
    }
    // Freshen even when the user aborted mid-flight — the 304 validated the
    // entry either way, and the store write benefits every other caller.
    this.#deliver(this.#mode === 'validated' ? this.#freshen() : this.#entry)
  }

  onError(err) {
    if (this.#mode === 'pass') {
      return this.#inner.onError(err)
    }
    if (this.#userAborted) {
      // The (probable) cause of this error is the user's own abort — a
      // stale-if-error serve would convert their cancellation into a
      // successful response.
      return this.#fail(this.#userAbortReason ?? err)
    }
    if (this.#mode === 'validated') {
      // The 304 already validated the entry; a broken tail on the (empty)
      // validation response doesn't invalidate it.
      return this.#deliver(this.#freshen())
    }
    if (this.#mode === 'stale' || this.#allowStaleOnError) {
      // Pre-response connection errors (ECONNREFUSED, reset, ...) count as
      // origin errors for stale-if-error — RFC 5861's definition explicitly
      // covers an unreachable origin (undici PR #5513). Mid-body failures of
      // a replacement response are 'pass' mode and propagate above.
      return this.#deliver(this.#entry)
    }
    this.#fail(err)
  }

  #deliver(entry) {
    if (this.#delivered) {
      return
    }
    this.#delivered = true
    if (this.#userAborted) {
      this.#userHandler.onError(this.#userAbortReason ?? new Error('aborted'))
    } else {
      serveFromCache(entry, this.#opts, this.#userHandler, this.#write, this.#url, this.#lookupMs)
    }
  }

  #fail(err) {
    if (!this.#delivered) {
      this.#delivered = true
      this.#userHandler.onError(err)
    }
  }

  /**
   * RFC 9111 §4.3.4: merge the 304's headers over the stored ones and reset
   * the freshness clock. Returns the entry to serve; the store is only
   * updated when the merged response is still storable.
   */
  #freshen() {
    const entry = this.#entry
    const headers304 = this.#headers304 ?? {}
    try {
      const now = Date.now()

      // Same exclusions as at store time — hop-by-hop, fields listed in the
      // 304's Connection header — plus Set-Cookie (must never enter a shared
      // entry) and the body-describing fields, for which the stored body is
      // authoritative.
      const excludedHeaders = new Set(['age', 'set-cookie', 'content-length', 'content-range'])
      const connection = headers304.connection
      if (typeof connection === 'string') {
        for (const name of connection.split(',')) {
          excludedHeaders.add(name.trim().toLowerCase())
        }
      } else if (Array.isArray(connection)) {
        for (const line of connection) {
          for (const name of `${line}`.split(',')) {
            excludedHeaders.add(name.trim().toLowerCase())
          }
        }
      }

      const merged = Object.create(null)
      for (const name of Object.keys(entry.headers ?? {})) {
        merged[name] = entry.headers[name]
      }
      for (const name of Object.keys(headers304)) {
        const lower = name.toLowerCase()
        if (isHopByHop(lower) || excludedHeaders.has(lower)) {
          continue
        }
        const val = headers304[name]
        merged[lower] = Array.isArray(val) ? val.slice() : val
      }

      // RFC 9110 §6.6.1: a 304 without a Date header is assigned the receipt
      // time. Without this, the stored (old) Date drives the corrected age
      // below and the freshened entry lands stale-on-arrival — permanently
      // revalidating on every hit despite the origin granting freshness.
      if (headers304.date == null) {
        merged.date = new Date(now).toUTCString()
      }

      const cacheControlDirectives = parseCacheControl(merged['cache-control']) ?? {}
      if (cacheControlDirectives['no-store'] || cacheControlDirectives.private === true) {
        // The origin has withdrawn (shared-)cacheability: serve this one
        // validated use, but don't freshen the stored entry — it stays stale
        // and keeps revalidating until it ages out.
        return { ...entry, headers: merged }
      }

      // Qualified no-cache=/private= field lists (possibly newly added by
      // the 304) must not survive in the stored — or served — headers, even
      // when the named field came from the original stored response.
      for (const directive of ['no-cache', 'private']) {
        if (Array.isArray(cacheControlDirectives[directive])) {
          for (const name of cacheControlDirectives[directive]) {
            delete merged[name]
          }
        }
      }

      const etag =
        typeof merged.etag === 'string' && isEtagUsable(merged.etag)
          ? merged.etag
          : (entry.etag ?? '')
      const hasValidator = etag !== '' || typeof merged['last-modified'] === 'string'

      let lifetimeInfo = determineLifetime(
        entry.statusCode,
        merged,
        cacheControlDirectives,
        this.#cacheOpts,
        now,
      )
      if (lifetimeInfo == null && cacheControlDirectives['no-cache'] === true) {
        lifetimeInfo = { lifetime: 0, explicit: true }
      }
      if (lifetimeInfo == null) {
        return { ...entry, headers: merged }
      }

      // Clamp the corrected age to the stored entry's own current age
      // (now - cachedAt already includes the original initial age, RFC 9111
      // §4.2.3): a skewed/old Date on the 304 must not push the freshened
      // entry further into the past than the response it just validated.
      const age = Math.min(
        determineAge(merged, now),
        Math.max(0, Math.floor((now - entry.cachedAt) / 1000)),
      )
      const times = computeEntryTimes(
        lifetimeInfo.lifetime,
        lifetimeInfo.explicit,
        age,
        cacheControlDirectives,
        this.#cacheOpts.maxEntryTTL ?? this.#store.maxEntryTTL ?? DEFAULT_MAX_ENTRY_TTL,
        hasValidator,
        now,
      )
      if (times == null) {
        return { ...entry, headers: merged }
      }

      // RFC 9111 §4.3.4: the 304 can carry an updated Vary. Recompute the
      // selector map from the merged Vary against this request's headers so
      // the stored metadata stays consistent with the served headers and
      // variant matching doesn't break if the origin changed Vary. A merged
      // Vary of '*' (or a non-string duplicate) makes the entry uncacheable —
      // serve this validated use but don't re-store it.
      const vary = parseVary(merged.vary, this.#key.headers)
      if (vary == null) {
        return { ...entry, headers: merged }
      }

      const freshened = {
        // 206 entries never take the revalidation path, so the stored body is
        // the full representation: start 0, end = byte length (0 for HEAD).
        body: entry.body ?? null,
        start: 0,
        end: entry.body ? entry.body.byteLength : 0,
        statusCode: entry.statusCode,
        statusMessage: entry.statusMessage ?? '',
        headers: merged,
        cacheControlDirectives,
        etag,
        vary,
        cachedAt: times.cachedAt,
        staleAt: times.staleAt,
        deleteAt: times.deleteAt,
      }

      // RFC 9111 §5.2.1.5: a request no-store forbids storing any part of
      // this request's response — serve the freshened value, don't write it.
      if (!this.#noStore) {
        try {
          this.#store.set(this.#key, freshened)
        } catch (err) {
          if (err.message === 'database is locked') {
            this.#logger?.debug({ err }, 'failed to freshen cache entry')
          } else {
            this.#logger?.error({ err }, 'failed to freshen cache entry')
          }
        }
      }

      return freshened
    } catch (err) {
      // Freshening must never break delivery of a validated entry.
      this.#logger?.error({ err }, 'failed to freshen cache entry')
      return entry
    }
  }
}

/**
 * Fire-and-forget background refresh for stale-while-revalidate (RFC 5861
 * §3): the caller was already served the stale entry; only the store observes
 * the outcome. Re-enters the dispatch chain below the cache interceptor.
 */
export function backgroundRefresh(dispatch, opts, key, store, entry) {
  let inflight = backgroundRefreshes.get(store)
  if (inflight == null) {
    inflight = new Set()
    backgroundRefreshes.set(store, inflight)
  }
  const refreshKey = `${key.method}:${key.origin}${key.path} ${varyKey(entry.vary)}`
  if (inflight.has(refreshKey)) {
    return
  }
  inflight.add(refreshKey)

  let finished = false
  const done = () => {
    if (!finished) {
      finished = true
      inflight.delete(refreshKey)
    }
  }

  const silentHandler = {
    onConnect: NOOP,
    onHeaders: () => true,
    onData: () => true,
    onComplete: done,
    onError: (err) => {
      done()
      opts.logger?.debug({ err }, 'cache: background revalidation failed')
    },
  }

  try {
    // Strip caller-specific request state: the body (already consumed or
    // owned by the caller) and the signal (a caller abort after being served
    // stale must not kill the shared refresh).
    const bgOpts = {
      ...opts,
      headers: conditionalHeaders(key.headers ?? {}, entry),
      body: null,
      signal: undefined,
    }
    dispatch(
      bgOpts,
      new RevalidationHandler(key, entry, bgOpts, {
        store,
        logger: opts.logger,
        handler: silentHandler,
        allowStaleOnError: false,
        noStore: false,
        cacheOpts: cacheOptsOf(opts),
      }),
    )
  } catch (err) {
    done()
    opts.logger?.debug({ err }, 'cache: background revalidation failed')
  }
}
