import undici from '@nxtedition/undici'
import { stringify } from 'fast-querystring'
import {
  DecoratorHandler,
  isStream,
  parseCacheControl,
  parseContentRange,
  parseHeaders,
  parseHttpDate,
} from '../utils.js'
import { isHopByHop } from './proxy.js'
import { SqliteCacheStore } from '../sqlite-cache-store.js'

let DEFAULT_STORE = null
const DEFAULT_MAX_ENTRY_SIZE = 128 * 1024
const DEFAULT_MAX_ENTRY_TTL = 30 * 24 * 3600 // seconds
// Bounded retention for entries kept solely for conditional revalidation
// (zero/expired freshness but a usable validator): long enough that the
// "always validate" origin pattern pays a 304 instead of a full 200, short
// enough not to pin dead content. Mirrors undici PR #5515 (24h).
const REVALIDATION_RETENTION = 24 * 3600 // seconds
// RFC 8246 'immutable' has no lifetime of its own; this is the customary
// 1-year default, capped by maxEntryTTL below.
const IMMUTABLE_LIFETIME = 31556952 // seconds
const NOOP = () => {}

// In-flight background stale-while-revalidate refreshes keyed by
// method + url, so a hot stale key spawns one refresh, not a herd.
const backgroundRefreshes = new Set()

/**
 * Explicit (or opt-in heuristic) freshness lifetime in seconds, or null when
 * the response carries no usable expiration information. RFC 9111 §4.2.1
 * priority for a shared cache: s-maxage > max-age > Expires. immutable
 * (RFC 8246) and the opt-in heuristics only apply when no explicit lifetime
 * is present. `explicit` marks origin-provided expiration — required for the
 * stale-on-arrival store-and-revalidate path (never keep heuristically-stale
 * content around for revalidation).
 *
 * @returns {{ lifetime: number, explicit: boolean } | null}
 */
function determineLifetime(
  statusCode,
  headers,
  cacheControlDirectives,
  { heuristic, defaultTTL },
  now,
) {
  const explicit = cacheControlDirectives['s-maxage'] ?? cacheControlDirectives['max-age']
  if (explicit != null) {
    return { lifetime: explicit, explicit: true }
  }

  if (headers.expires != null) {
    // RFC 9111 §5.3: an invalid Expires (notably `Expires: 0`) means already
    // expired — the parse failure must surface as lifetime 0, not fall through
    // to heuristics. Arrays (duplicated, potentially conflicting Expires field
    // lines) are treated the same way.
    const expires = typeof headers.expires === 'string' ? parseHttpDate(headers.expires) : undefined
    if (!expires) {
      return { lifetime: 0, explicit: true }
    }
    const date = typeof headers.date === 'string' ? parseHttpDate(headers.date) : undefined
    return {
      lifetime: Math.floor((expires.getTime() - (date ? date.getTime() : now)) / 1000),
      explicit: true,
    }
  }

  if (cacheControlDirectives.immutable) {
    return { lifetime: IMMUTABLE_LIFETIME, explicit: false }
  }

  // Heuristic freshness and defaultTTL are per-request client opt-ins and
  // deliberately restricted to plain 200s — heuristically extending 206/307
  // would cache partials and temporary redirects without origin consent.
  if (statusCode === 200) {
    if (heuristic && typeof headers['last-modified'] === 'string') {
      // RFC 9111 §4.2.2 suggested heuristic: 10% of time since Last-Modified.
      // §4.2.2 forbids heuristics when an explicit expiration exists; Expires
      // was handled (including the invalid form) above, so this is reached
      // only when none does.
      const lastModified = parseHttpDate(headers['last-modified'])
      if (lastModified && lastModified.getTime() < now) {
        return { lifetime: Math.floor((now - lastModified.getTime()) / 10 / 1000), explicit: false }
      }
    }
    if (typeof defaultTTL === 'number' && defaultTTL > 0) {
      return { lifetime: defaultTTL, explicit: false }
    }
  }

  return null
}

/**
 * Corrected initial age in whole seconds per RFC 9111 §4.2.3 (simplified):
 * the larger of the Age header and the apparent age (receipt time minus the
 * origin Date). A response relayed through intermediaries that don't add Age
 * would otherwise get an over-extended TTL and be served stale.
 */
function determineAge(headers, now) {
  const rawAge = headers.age
  // A duplicated Age header arrives as an array; take the first value like
  // upstream — Number(array) would yield NaN and silently read as age 0.
  const age = parseInt(Array.isArray(rawAge) ? rawAge[0] : rawAge, 10)
  const date = typeof headers.date === 'string' ? parseHttpDate(headers.date) : undefined
  const apparentAge = date ? Math.max(0, Math.floor((now - date.getTime()) / 1000)) : 0
  return Math.max(Number.isFinite(age) && age > 0 ? age : 0, apparentAge)
}

/**
 * Computes the entry's absolute times, or null when it shouldn't be stored.
 *
 * cachedAt is backdated by the corrected initial age so all downstream age
 * math (served Age header, freshness and request-directive checks) reduces to
 * `now - cachedAt`; the origin Age header is stripped before storing to match.
 *
 * staleAt splits freshness from retention: entries are RETAINED past staleAt
 * (deleteAt) so a stale hit can be revalidated with a conditional request
 * instead of refetched in full. Retention is 2x the freshness lifetime
 * (undici PR #4913's revalidation buffer), extended by stale-while-revalidate
 * / stale-if-error windows (RFC 5861) and to REVALIDATION_RETENTION for
 * validator-bearing entries; everything is capped by maxEntryTTL, measured
 * from (backdated) cachedAt.
 */
function computeEntryTimes(
  lifetime,
  explicit,
  age,
  cacheControlDirectives,
  maxEntryTTL,
  hasValidator,
  now,
) {
  if (!Number.isFinite(lifetime)) {
    return null
  }

  const freshness = Math.min(lifetime, maxEntryTTL) // seconds; may be <= 0
  if (freshness - age <= 0 && !(hasValidator && explicit)) {
    // Stale on arrival and no cheap way to revalidate — not worth storing.
    return null
  }

  const cachedAt = now - age * 1000
  const staleAt = cachedAt + freshness * 1000

  const swr = cacheControlDirectives['stale-while-revalidate']
  const sie = cacheControlDirectives['stale-if-error']
  const staleOffset = Math.max(freshness, 0)
  let retention = staleOffset * 2
  if (typeof swr === 'number' && swr > 0) {
    retention = Math.max(retention, staleOffset + swr)
  }
  if (typeof sie === 'number' && sie > 0) {
    retention = Math.max(retention, staleOffset + sie)
  }
  if (hasValidator && explicit) {
    retention = Math.max(retention, age + REVALIDATION_RETENTION)
  }
  retention = Math.min(retention, maxEntryTTL)

  const deleteAt = cachedAt + retention * 1000
  if (deleteAt <= now) {
    return null
  }

  return { cachedAt, staleAt, deleteAt }
}

/**
 * RFC 9111 §5.2.2.2 / §5.2.2.8 (and undici PR #5511): must-revalidate and
 * proxy-revalidate (we are a shared cache) veto every stale-serving path —
 * max-stale, stale-while-revalidate and stale-if-error.
 */
function forbidsServingStale(entry) {
  const directives = entry.cacheControlDirectives
  return directives?.['must-revalidate'] === true || directives?.['proxy-revalidate'] === true
}

/**
 * Conditional request headers for revalidating a stored entry (RFC 9111
 * §4.3.1). Per RFC 9110 §13.1.3 and undici PR #5512, If-Modified-Since echoes
 * the stored Last-Modified VERBATIM when available (nginx's default
 * `if_modified_since exact` requires a byte-identical value), falling back to
 * the response Date, then to the (backdated) receipt time.
 *
 * The stored vary values need no replay: the store only returns entries whose
 * selecting headers already match this request.
 */
function conditionalHeaders(headers, entry) {
  const condHeaders = { ...headers }
  if (entry.etag) {
    condHeaders['if-none-match'] = entry.etag
  }
  const lastModified = entry.headers?.['last-modified']
  const date = entry.headers?.date
  condHeaders['if-modified-since'] =
    typeof lastModified === 'string'
      ? lastModified
      : typeof date === 'string'
        ? date
        : new Date(entry.cachedAt).toUTCString()
  return condHeaders
}

class CacheHandler extends DecoratorHandler {
  #key
  #value
  #store
  #logger
  #maxEntrySize
  #maxEntryTTL
  #heuristic
  #defaultTTL

  constructor(key, { store, logger, handler, maxEntrySize, maxEntryTTL, heuristic, defaultTTL }) {
    super(handler)

    this.#key = key
    this.#logger = logger
    this.#value = null
    this.#store = store
    this.#maxEntrySize = maxEntrySize ?? store.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE
    this.#maxEntryTTL = maxEntryTTL ?? store.maxEntryTTL ?? DEFAULT_MAX_ENTRY_TTL
    this.#heuristic = heuristic ?? false
    this.#defaultTTL = defaultTTL ?? null
  }

  onConnect(abort) {
    this.#value = null

    super.onConnect((reason) => {
      // TODO (fix): Cache partial results?
      abort(reason)
    })
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode !== 307 && statusCode !== 200 && statusCode !== 206) {
      return super.onHeaders(statusCode, headers, resume)
    }

    // 'trailer' is the RFC 9110 field name; 'trailers' is kept for backwards
    // compatibility with servers that misspell it.
    if (headers.vary === '*' || headers.trailer || headers.trailers) {
      // Not cacheble...
      return super.onHeaders(statusCode, headers, resume)
    }

    if (headers['set-cookie']) {
      // Shared cache: replaying Set-Cookie to other clients leaks sessions.
      return super.onHeaders(statusCode, headers, resume)
    }

    let contentRange
    if (headers['content-range']) {
      contentRange = parseContentRange(headers['content-range'])
      if (
        contentRange == null ||
        (contentRange.end != null &&
          (contentRange.end <= contentRange.start ||
            (contentRange.size != null && contentRange.end > contentRange.size)))
      ) {
        // We don't support caching responses with invalid content-range...
        return super.onHeaders(statusCode, headers, resume)
      }
      if (this.#key.method === 'HEAD') {
        // A HEAD response delivers no body, so we never receive the byte
        // window Content-Range describes — storing it would fail the store's
        // body-length validation.
        return super.onHeaders(statusCode, headers, resume)
      }
    }

    let contentLength
    if (headers['content-length']) {
      contentLength = Number(headers['content-length'])
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        // We don't support caching responses with invalid content-length...
        return super.onHeaders(statusCode, headers, resume)
      }
    }

    if (statusCode === 206 && !contentRange) {
      // We don't support caching range responses without content-range...
      return super.onHeaders(statusCode, headers, resume)
    }

    const cacheControlDirectives = parseCacheControl(headers['cache-control']) ?? {}

    // RFC 9111 §3.5: a shared cache may store a response to a request with
    // Authorization only when the response explicitly allows it: public,
    // s-maxage, or must-revalidate (safe because such entries are never
    // served stale without successful revalidation). Must stay in lockstep
    // with the serve-side gate in the interceptor below. A duplicated
    // (array) authorization header is refused outright.
    const authorization = this.#key.headers.authorization
    if (authorization != null) {
      if (
        typeof authorization !== 'string' ||
        !(
          cacheControlDirectives.public === true ||
          cacheControlDirectives['s-maxage'] != null ||
          cacheControlDirectives['must-revalidate'] === true
        )
      ) {
        return super.onHeaders(statusCode, headers, resume)
      }
    }

    // Unqualified private forbids shared-cache storage entirely; the
    // qualified form (private="field") only forbids storing the listed
    // fields, which are stripped below (RFC 9111 §5.2.2.7).
    if (cacheControlDirectives['no-store'] || cacheControlDirectives.private === true) {
      return super.onHeaders(statusCode, headers, resume)
    }

    if (cacheControlDirectives['must-understand']) {
      // Do nothing. We only cache responses that we understand...
    }

    if (cacheControlDirectives['no-transform']) {
      // Do nothing. We don't transform responses...
    }

    // must-revalidate / proxy-revalidate / unqualified no-cache /
    // stale-while-revalidate / stale-if-error responses ARE stored: the
    // directives constrain how the entry may be reused (validate first, never
    // serve stale, ...), which the read path enforces from the persisted
    // cacheControlDirectives.

    // Null prototype: selector names come from the response Vary header and
    // request header names are caller-controlled — on a plain `{}` a
    // `__proto__` key would hit the prototype setter and be silently dropped.
    const vary = Object.create(null)
    if (headers.vary) {
      if (typeof headers.vary !== 'string') {
        return super.onHeaders(statusCode, headers, resume)
      }

      for (const key of headers.vary.split(',').map((key) => key.trim().toLowerCase())) {
        if (key === '*') {
          // RFC 9111 §4.1: a Vary field containing '*' never matches.
          return super.onHeaders(statusCode, headers, resume)
        }
        // Record every selecting header, using a null sentinel when it was
        // absent from the request. RFC 9111 §4.1: absent-vs-present is a
        // mismatch, so an empty vary object must NOT act as a wildcard that
        // matches requests which later supply the header. headerValueEquals
        // treats null/absent as equal only to another null/absent.
        vary[key] = this.#key.headers[key] ?? null
      }
    }

    const now = Date.now()

    let lifetimeInfo = determineLifetime(
      statusCode,
      headers,
      cacheControlDirectives,
      { heuristic: this.#heuristic, defaultTTL: this.#defaultTTL },
      now,
    )
    if (lifetimeInfo == null && cacheControlDirectives['no-cache'] === true) {
      // Store-and-revalidate (undici PR #5515): no expiration information at
      // all, but unqualified no-cache plus a validator means every reuse can
      // cost a 304 instead of a full 200.
      lifetimeInfo = { lifetime: 0, explicit: true }
    }
    if (lifetimeInfo == null) {
      return super.onHeaders(statusCode, headers, resume)
    }

    const etag = typeof headers.etag === 'string' && isEtagUsable(headers.etag) ? headers.etag : ''
    const hasValidator = etag !== '' || typeof headers['last-modified'] === 'string'
    const age = determineAge(headers, now)
    const times = computeEntryTimes(
      lifetimeInfo.lifetime,
      lifetimeInfo.explicit,
      age,
      cacheControlDirectives,
      this.#maxEntryTTL,
      hasValidator,
      now,
    )
    if (times == null) {
      return super.onHeaders(statusCode, headers, resume)
    }

    const start = contentRange ? contentRange.start : 0
    // HEAD never delivers a body, so a Content-Length must not drive the
    // stored byte window (end). Storing end = contentLength with an empty body
    // would fail the store's body-length validation and emit error-level log
    // spam on every cacheable HEAD response.
    const end = contentRange ? contentRange.end : this.#key.method === 'HEAD' ? 0 : contentLength

    if (end == null || end - start <= this.#maxEntrySize) {
      // Snapshot the headers: the same object is delivered downstream to the
      // caller (request() resolves with it before the body finishes), and the
      // entry isn't serialized to the store until onComplete. Without a copy,
      // any mutation the caller makes to res.headers while the body streams
      // would be persisted into the shared cache and replayed to every later
      // request. parseHeaders values are strings or string arrays, so a
      // one-level copy with array values sliced is a full snapshot. Use
      // Object.keys so only own enumerable header fields are copied — never
      // inherited properties from the prototype chain. Null prototype: on a
      // plain `{}` a header literally named `__proto__` would hit the
      // Object.prototype setter instead of becoming a data property (silent
      // drop / prototype-pollution vector).
      //
      // Stripped while copying (RFC 9111 §3.1): hop-by-hop fields, fields
      // listed in the Connection header, fields named by qualified
      // no-cache=/private= directives (§5.2.2.4/§5.2.2.7), and Age — cachedAt
      // is backdated by the corrected initial age, so the served Age is fully
      // recomputed and a stored Age would double-count.
      const excludedHeaders = new Set(['age'])
      const connection = headers.connection
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
      if (Array.isArray(cacheControlDirectives['no-cache'])) {
        for (const name of cacheControlDirectives['no-cache']) {
          excludedHeaders.add(name)
        }
      }
      if (Array.isArray(cacheControlDirectives.private)) {
        for (const name of cacheControlDirectives.private) {
          excludedHeaders.add(name)
        }
      }

      const storedHeaders = Object.create(null)
      for (const name of Object.keys(headers)) {
        if (isHopByHop(name) || excludedHeaders.has(name.toLowerCase())) {
          continue
        }
        const val = headers[name]
        storedHeaders[name] = Array.isArray(val) ? val.slice() : val
      }

      this.#value = {
        body: [],
        start,
        end,
        cachedAt: times.cachedAt,
        staleAt: times.staleAt,
        deleteAt: times.deleteAt,
        statusCode,
        statusMessage: '',
        headers: storedHeaders,
        cacheControlDirectives,
        etag,
        vary,
        // Handler state.
        size: 0,
      }
    }

    return super.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    if (this.#value) {
      this.#value.size += chunk.length
      this.#value.body.push(chunk)

      if (this.#value.size > this.#maxEntrySize) {
        this.#value = null
      }
    }

    return super.onData(chunk)
  }

  onComplete(trailers) {
    if (this.#value && (!trailers || Object.keys(trailers).length === 0)) {
      this.#value.end ??= this.#value.start + this.#value.size
      try {
        this.#store.set(this.#key, this.#value)
      } catch (err) {
        if (err.message === 'database is locked') {
          // Database is busy. We don't bother trying again...
          this.#logger?.debug({ err }, 'failed to set cache entry')
        } else {
          this.#logger?.error({ err }, 'failed to set cache entry')
        }
      }
      this.#value = null
    }

    super.onComplete(trailers)
  }
}

/**
 * Drives a conditional (revalidation) request to the origin for a stale
 * stored entry (RFC 9111 §4.3). Decision at response headers:
 * - 304: the entry is valid — freshen it (§4.3.4) and serve it.
 * - 5xx within the stale-if-error window (RFC 5861 §4, incl. undici PR
 *   #5513's pre-response connection errors): discard the error and serve the
 *   stale entry.
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
class RevalidationHandler {
  #key
  #entry
  #store
  #logger
  #opts
  #cacheOpts
  #userHandler
  #allowStaleOnError
  #noStore
  /** @type {null | 'pass' | 'validated' | 'stale'} */
  #mode = null
  /** @type {CacheHandler | import('../utils.js').DecoratorHandler | object | null} */
  #inner = null
  /** @type {((reason?: any) => void) | null} */
  #abort = null
  /** @type {Record<string, string | string[]> | null} */
  #headers304 = null
  #delivered = false
  #userAborted = false
  #userAbortReason = null

  constructor(key, entry, opts, { store, logger, handler, allowStaleOnError, noStore, cacheOpts }) {
    this.#key = key
    this.#entry = entry
    this.#store = store
    this.#logger = logger
    this.#opts = opts
    this.#cacheOpts = cacheOpts
    this.#userHandler = handler
    this.#allowStaleOnError = allowStaleOnError
    this.#noStore = noStore ?? false
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

    if (this.#allowStaleOnError && statusCode >= 500 && statusCode <= 504) {
      this.#mode = 'stale'
      // Drain and discard the error body.
      return true
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
      serveFromCache(entry, this.#opts, this.#userHandler)
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
        vary: entry.vary,
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
 * RFC 9111 §4.4: a non-error response to an unsafe method invalidates the
 * stored entries for the target URI and any same-origin Location /
 * Content-Location URIs (undici PR #5514). Cross-origin targets are skipped —
 * honoring an attacker-influenced Location against another origin's entries
 * would be a cache-poisoning vector.
 */
class InvalidationHandler extends DecoratorHandler {
  #key
  #store
  #logger

  constructor(key, { store, logger, handler }) {
    super(handler)
    this.#key = key
    this.#store = store
    this.#logger = logger
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode >= 200 && statusCode <= 399) {
      // Invalidation failures must never break the actual response. Deletes
      // are idempotent, so a retry re-driving onHeaders is harmless.
      try {
        this.#invalidate(headers)
      } catch (err) {
        if (err.message === 'database is locked') {
          this.#logger?.debug({ err }, 'failed to invalidate cache entry')
        } else {
          this.#logger?.error({ err }, 'failed to invalidate cache entry')
        }
      }
    }
    return super.onHeaders(statusCode, headers, resume)
  }

  #invalidate(headers) {
    this.#store.delete(this.#key)

    const invalidated = new Set([this.#key.path])
    let base
    for (const name of ['location', 'content-location']) {
      let value = headers[name]
      if (Array.isArray(value)) {
        value = value[0]
      }
      if (typeof value !== 'string' || value === '') {
        continue
      }

      base ??= new URL(this.#key.path, this.#key.origin)
      let target
      try {
        target = new URL(value, base)
      } catch {
        continue
      }
      if (target.origin !== base.origin) {
        continue
      }

      const path = target.pathname + target.search
      if (!invalidated.has(path)) {
        invalidated.add(path)
        this.#store.delete({ ...this.#key, path })
      }
    }
  }
}

function getStore(opts) {
  return opts.cache.store ?? (DEFAULT_STORE ??= new SqliteCacheStore({ location: ':memory:' }))
}

function tryGetEntry(store, key, logger) {
  try {
    return store.get(key)
  } catch (err) {
    if (err.message === 'database is locked') {
      // Database is busy. We don't bother trying again...
      logger?.debug({ err }, 'failed to get cache entry')
    } else {
      logger?.error({ err }, 'failed to get cache entry')
    }
  }
}

/**
 * Builds the cache key shared by the get and set paths.
 */
function makeKey(opts) {
  // Build the key the same way for lookups and stores: makeCacheKey
  // stringifies the origin (e.g. URL objects), so using raw opts on the get
  // path while the set path normalizes would make the cache permanently miss.
  // The flat name/value array form of opts.headers (legal at the undici
  // client level) makes makeCacheKey throw — normalize it through
  // parseHeaders first (which also lowercases the names).
  const key = undici.util.cache.makeCacheKey(
    Array.isArray(opts.headers) ? { ...opts, headers: parseHeaders(opts.headers) } : opts,
  )

  // makeCacheKey preserves request header names verbatim. Vary selector names
  // are lowercased (in CacheHandler and matchesValue), so lowercase the key's
  // header names once here — the same key feeds both the get and set paths, so
  // this keeps Vary matching symmetric even when a caller supplies non-lowercase
  // header names (the standalone interceptors.cache() composition; the wrapped
  // pipeline already normalizes). A fresh object avoids mutating opts.headers.
  // Header names are caller-controlled, so build a null-prototype map (a
  // `__proto__` key on a plain object would silently overwrite the prototype
  // instead of setting a property) and copy own keys only.
  if (key.headers && typeof key.headers === 'object') {
    const lower = Object.create(null)
    for (const name of Object.keys(key.headers)) {
      lower[name.toLowerCase()] = key.headers[name]
    }
    key.headers = lower
  }

  // The vendored makeCacheKey ignores opts.query. The wrapped pipeline is
  // immune (the query interceptor rewrites path before the cache sees it),
  // but a standalone interceptors.cache() composition would silently collide
  // distinct query strings onto one entry and serve the wrong response
  // (undici issue #4209 / PR #5081) — fold the query into the key path.
  if (
    opts.query &&
    typeof key.path === 'string' &&
    !key.path.includes('?') &&
    !key.path.includes('#')
  ) {
    const qs = stringify(opts.query)
    if (qs) {
      key.path = `${key.path || '/'}?${qs}`
    }
  }

  return key
}

function cacheOptsOf(opts) {
  return {
    maxEntrySize: opts.cache.maxEntrySize,
    maxEntryTTL: opts.cache.maxEntryTTL,
    heuristic: opts.cache.heuristic,
    defaultTTL: opts.cache.defaultTTL,
  }
}

/**
 * Fire-and-forget background refresh for stale-while-revalidate (RFC 5861
 * §3): the caller was already served the stale entry; only the store observes
 * the outcome. Re-enters the dispatch chain below the cache interceptor.
 */
function backgroundRefresh(dispatch, opts, key, store, entry) {
  const refreshKey = `${key.method}:${key.origin}${key.path}`
  if (backgroundRefreshes.has(refreshKey)) {
    return
  }
  backgroundRefreshes.add(refreshKey)

  let finished = false
  const done = () => {
    if (!finished) {
      finished = true
      backgroundRefreshes.delete(refreshKey)
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

export default () => (dispatch) => (opts, handler) => {
  if (!opts.cache || opts.upgrade) {
    return dispatch(opts, handler)
  }

  if (opts.method !== 'GET' && opts.method !== 'HEAD') {
    // RFC 9110 §9.2.1: OPTIONS and TRACE are safe — never cached, but they
    // must not invalidate either. Every other method (POST/PUT/DELETE/...)
    // invalidates the target URI on a non-error response (RFC 9111 §4.4).
    if (opts.method === 'OPTIONS' || opts.method === 'TRACE') {
      return dispatch(opts, handler)
    }

    const store = getStore(opts)
    if (typeof store.delete !== 'function') {
      // User-supplied store without invalidation support.
      return dispatch(opts, handler)
    }

    return dispatch(
      opts,
      new InvalidationHandler(makeKey(opts), { store, logger: opts.logger, handler }),
    )
  }

  // TODO (fix): enable range requests

  const key = makeKey(opts)

  // All request-directive and conditional-header guards below MUST read from
  // the lowercased key.headers, not raw opts.headers — otherwise a caller
  // supplying capitalized names (e.g. `Authorization`, `Cache-Control` via the
  // standalone composition) would silently skip the guards while the store
  // side (CacheHandler) reads the lowercased form, e.g. serving a non-public
  // cached response to an authorized request (RFC 9111 §3.5).
  const headers = key.headers ?? {}

  const rawCacheControl = headers['cache-control']
  const requestCacheControl = parseCacheControl(rawCacheControl) ?? {}

  // RFC 9111 Section 5.4: Pragma: no-cache should be treated as
  // Cache-Control: no-cache when Cache-Control is absent.
  if (rawCacheControl == null && headers.pragma === 'no-cache') {
    requestCacheControl['no-cache'] = true
  }

  if (requestCacheControl['no-transform']) {
    // Do nothing. We don't transform requests...
  }

  const onlyIfCached = requestCacheControl['only-if-cached'] === true
  const store = getStore(opts)

  let entry = tryGetEntry(store, key, opts.logger)

  // RFC 9111 §3.5 serve-side authorization gate: a shared cache must not
  // reuse a stored response for a request with Authorization unless the
  // response allowed it (public, s-maxage or must-revalidate — the mirror of
  // the store-side gate in CacheHandler; both sites must stay in lockstep).
  if (entry && headers.authorization != null) {
    const directives = entry.cacheControlDirectives
    if (
      typeof headers.authorization !== 'string' ||
      !(
        directives?.public === true ||
        directives?.['s-maxage'] != null ||
        directives?.['must-revalidate'] === true
      )
    ) {
      entry = undefined
    }
  }

  // Freshness for THIS request: the entry's staleAt, tightened by the
  // caller's max-age / min-fresh (RFC 9111 §5.2.1.1 / §5.2.1.3). Date.now()
  // rather than getFastNow(): zero-TTL revalidation entries (staleAt ==
  // cachedAt) would read as fresh for up to a second on the lagging clock.
  //
  // requestAccepts is tracked separately from origin freshness because it
  // constrains EVERY serving path below, including the stale-serving windows
  // (max-stale, stale-while-revalidate, stale-if-error): those directives
  // relax the response-computed staleness bound, they must not un-reject an
  // entry the caller's own age bounds refused — otherwise an origin emitting
  // stale-while-revalidate would silently disable clients' max-age=0.
  const now = Date.now()
  const requestAccepts =
    entry == null ||
    // `!= null`: max-age=0 parses to 0 (falsy) but still demands a response
    // no older than 0 seconds.
    ((requestCacheControl['max-age'] == null ||
      (now - entry.cachedAt) / 1000 < requestCacheControl['max-age']) &&
      (requestCacheControl['min-fresh'] == null ||
        entry.staleAt - now > requestCacheControl['min-fresh'] * 1000))
  const fresh = entry != null && now < entry.staleAt && requestAccepts

  // Validation demanded regardless of freshness: the request's no-cache (or
  // Pragma), or the stored response's unqualified no-cache (§5.2.2.4).
  const mustRevalidate =
    entry != null &&
    (requestCacheControl['no-cache'] === true ||
      entry.cacheControlDirectives?.['no-cache'] === true)

  // RFC 9110 Section 13: Evaluate conditional request headers against cached
  // entry — only against a FRESH entry that doesn't demand validation;
  // answering 304 from a stale entry without validating would violate RFC
  // 9111 §4.3.2. Stale + caller conditionals forward to the origin below,
  // where the caller's own validators do the validation (a 304 flows through
  // to the caller; a 200 replacement is stored by CacheHandler).
  // typeof guards: duplicated conditional headers arrive as arrays — treat
  // them as non-matching and bypass to origin rather than crashing.
  const servableFromCache = entry != null && fresh && !mustRevalidate
  if (servableFromCache && headers['if-none-match']) {
    if (
      typeof headers['if-none-match'] === 'string' &&
      entry.etag &&
      weakMatch(headers['if-none-match'], entry.etag)
    ) {
      return serveFromCache(
        { statusCode: 304, headers: entry.headers, cachedAt: entry.cachedAt },
        opts,
        handler,
      )
    }
    // Etag didn't match — bypass to origin.
    entry = undefined
  } else if (servableFromCache && headers['if-modified-since']) {
    const lastModified = entry.headers?.['last-modified']
    if (
      typeof headers['if-modified-since'] === 'string' &&
      lastModified &&
      new Date(lastModified) <= new Date(headers['if-modified-since'])
    ) {
      return serveFromCache(
        { statusCode: 304, headers: entry.headers, cachedAt: entry.cachedAt },
        opts,
        handler,
      )
    }
    // No last-modified or modified since — bypass to origin.
    entry = undefined
  } else if (entry && (headers['if-none-match'] || headers['if-modified-since'])) {
    entry = undefined
  }

  if (headers['if-match'] || headers['if-unmodified-since'] || headers['if-range']) {
    // TODO (fix): evaluate these conditional headers against cached entry.
    return dispatch(opts, handler)
  }

  const cacheHandler = () =>
    new CacheHandler(key, {
      ...cacheOptsOf(opts),
      store,
      logger: opts.logger,
      handler,
    })

  if (!entry) {
    if (onlyIfCached) {
      // RFC 9111 §5.2.1.7: no stored response usable without contacting the
      // origin — 504.
      return serveFromCache({ statusCode: 504 }, opts, handler)
    }
    // Request directives (no-cache, max-age, ...) constrain REUSE of a stored
    // response, not storage of a fresh one (undici PR #5510): every miss path
    // keeps the CacheHandler write-back so one client's freshness override
    // doesn't disable caching of the URL for everyone. Only the request's
    // no-store forbids storing.
    return dispatch(opts, requestCacheControl['no-store'] ? handler : cacheHandler())
  }

  if (fresh && !mustRevalidate) {
    return serveFromCache(entry, opts, handler)
  }

  // RFC 9111 §5.2.1.2: the caller accepts staleness up to max-stale (bare
  // max-stale parses to Infinity: any staleness) — vetoed by the response's
  // must-revalidate/proxy-revalidate (§5.2.2.2) and by the caller's own
  // max-age/min-fresh bounds (requestAccepts).
  if (
    !mustRevalidate &&
    requestAccepts &&
    requestCacheControl['max-stale'] != null &&
    !forbidsServingStale(entry) &&
    now <= entry.staleAt + requestCacheControl['max-stale'] * 1000
  ) {
    return serveFromCache(entry, opts, handler)
  }

  if (onlyIfCached) {
    // Stale (or validation-demanding) entry and the origin is off-limits.
    return serveFromCache({ statusCode: 504 }, opts, handler)
  }

  if (entry.statusCode === 206) {
    // Range entries can't be revalidated as a whole representation — refetch.
    return dispatch(opts, requestCacheControl['no-store'] ? handler : cacheHandler())
  }

  // RFC 5861 §3 stale-while-revalidate: serve the stale entry immediately and
  // refresh in the background — unless validation is demanded, the response
  // forbids serving stale, or the caller's own max-age/min-fresh bounds
  // rejected the entry (they demand a validated/younger response NOW).
  if (
    !mustRevalidate &&
    requestAccepts &&
    !forbidsServingStale(entry) &&
    typeof entry.cacheControlDirectives?.['stale-while-revalidate'] === 'number' &&
    now <= entry.staleAt + entry.cacheControlDirectives['stale-while-revalidate'] * 1000
  ) {
    try {
      serveFromCache(entry, opts, handler)
    } finally {
      backgroundRefresh(dispatch, opts, key, store, entry)
    }
    return
  }

  // Synchronous revalidation (RFC 9111 §4.3): conditional request; 304
  // freshens and serves the entry, an error within the stale-if-error window
  // (RFC 5861 §4: response directive first, request directive fallback —
  // vetoed by must-revalidate/proxy-revalidate) serves the stale entry, and
  // anything else replaces it.
  const staleIfError =
    entry.cacheControlDirectives?.['stale-if-error'] ?? requestCacheControl['stale-if-error']
  const allowStaleOnError =
    !mustRevalidate &&
    requestAccepts &&
    !forbidsServingStale(entry) &&
    typeof staleIfError === 'number' &&
    staleIfError > 0 &&
    now <= entry.staleAt + staleIfError * 1000

  return dispatch(
    { ...opts, headers: conditionalHeaders(headers, entry) },
    new RevalidationHandler(key, entry, opts, {
      store,
      logger: opts.logger,
      handler,
      allowStaleOnError,
      noStore: requestCacheControl['no-store'] === true,
      cacheOpts: cacheOptsOf(opts),
    }),
  )
}

function serveFromCache(entry, opts, handler) {
  const { statusCode, trailers, body } = entry

  let headers = entry.headers
  if (entry.cachedAt != null) {
    // RFC 9111 §5.1: every response served from cache must carry an Age
    // header. cachedAt is backdated by the corrected initial age at store
    // time (§4.2.3) and the origin's Age header is stripped, so resident time
    // IS the response's age — no origin-Age addition. Date.now(), not
    // getFastNow(): the lagging clock would understate a relayed response's
    // initial age by up to a second.
    const age = Math.max(0, Math.floor((Date.now() - entry.cachedAt) / 1000))
    headers = { ...headers, age: `${age}` }
  }

  // serveFromCache drives the raw user handler directly (no DecoratorHandler),
  // so it must enforce the contract itself: onError is terminal and mutually
  // exclusive with onComplete. The `completed` guard makes a late abort() a
  // no-op, and onComplete runs outside the try so a throw from the user's
  // terminal callback propagates instead of being converted into a second
  // (post-complete) onError.
  let aborted = false
  let completed = false
  const abort = (reason) => {
    if (!aborted && !completed) {
      aborted = true
      handler.onError(reason)
    }
  }

  // Dump the request body so its underlying resources are released. Only a
  // stream needs draining; a Buffer/string body has no .on()/.resume(), and
  // calling them would throw a TypeError that aborts an otherwise-valid cache
  // hit (a cached GET/HEAD issued with a non-stream body).
  if (isStream(opts.body)) {
    opts.body.on('error', () => {}).resume()
  }

  try {
    handler.onConnect(abort)
    if (aborted) {
      return
    }

    handler.onHeaders(statusCode, headers ?? {}, NOOP)
    if (aborted) {
      return
    }

    if (body?.byteLength) {
      handler.onData(body)
      if (aborted) {
        return
      }
    }
  } catch (err) {
    abort(err)
    return
  }

  completed = true
  handler.onComplete(trailers ?? {})
}

/**
 * RFC 9110 Section 8.8.3.2: Weak comparison — two etags match if their
 * opaque-tags match, ignoring the W/ prefix.
 *
 * @param {string} ifNoneMatch - The If-None-Match header value (may contain multiple etags)
 * @param {string} etag - The cached etag
 * @returns {boolean}
 */
function weakMatch(ifNoneMatch, etag) {
  if (ifNoneMatch === '*') {
    return true
  }

  const normalize = (tag) => (tag.startsWith('W/') ? tag.slice(2) : tag)
  const cached = normalize(etag)

  for (const raw of ifNoneMatch.split(',')) {
    if (normalize(raw.trim()) === cached) {
      return true
    }
  }

  return false
}

/**
 * Note: this deviates from the spec a little. Empty etags ("", W/"") are valid,
 *  however, including them in cached resposnes serves little to no purpose.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9110.html#name-etag
 *
 * @param {string|any} etag
 * @returns {boolean}
 */
function isEtagUsable(etag) {
  if (typeof etag !== 'string') {
    return false
  }

  if (etag.length <= 2) {
    // Shortest an etag can be is two chars (just ""). This is where we deviate
    //  from the spec requiring a min of 3 chars however
    return false
  }

  if (etag[0] === '"' && etag[etag.length - 1] === '"') {
    // ETag: ""asd123"" or ETag: "W/"asd123"", kinda undefined behavior in the
    //  spec. Some servers will accept these while others don't.
    // ETag: "asd123"
    return !(etag[1] === '"' || etag.startsWith('"W/'))
  }

  if (etag.startsWith('W/"') && etag[etag.length - 1] === '"') {
    // ETag: W/"", also where we deviate from the spec & require a min of 3
    //  chars
    // ETag: for W/"", W/"asd123"
    return etag.length !== 4
  }

  // Anything else
  return false
}
