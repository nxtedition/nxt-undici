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
import { traceWrite, traceSafe, traceErr, traceUrl } from '../trace.js'

let DEFAULT_STORE = null
const DEFAULT_MAX_ENTRY_SIZE = 128 * 1024
const DEFAULT_MAX_ENTRY_TTL = 30 * 24 * 3600 // seconds
// RFC 8246 'immutable' has no lifetime of its own; this is the customary
// 1-year default, capped by maxEntryTTL below.
const IMMUTABLE_LIFETIME = 31556952 // seconds
const NOOP = () => {}

// Emit the per-dispatch `undici:cache` lookup doc at the outcome decision
// (hit/miss/bypass). Call sites gate on the write fn captured once at the
// dispatch entry (log.js style), so the off path pays no doc building; result
// and reason stay low-cardinality (they become ES keywords).
function traceLookup(write, opts, url, result, reason, statusCode, ageSec, sizeBytes, lookupMs) {
  traceSafe(
    write,
    {
      id: opts.id ?? null,
      method: opts.method ?? null,
      url,
      result,
      reason,
      statusCode,
      ageSec,
      sizeBytes,
      lookupMs,
    },
    'undici:cache',
  )
}

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
  // A duplicated Age header arrives as an array; take the first value.
  const rawAgeValue = Array.isArray(rawAge) ? rawAge[0] : rawAge
  // RFC 9111 §5.1 Age is delta-seconds (1*DIGIT): require a pure integer so a
  // malformed value like "5junk" isn't parseInt-coerced to 5 and used to
  // backdate cachedAt / extend staleness.
  const age =
    typeof rawAgeValue === 'string' && /^\d+$/.test(rawAgeValue.trim())
      ? parseInt(rawAgeValue, 10)
      : 0
  const date = typeof headers.date === 'string' ? parseHttpDate(headers.date) : undefined
  const apparentAge = date ? Math.max(0, Math.floor((now - date.getTime()) / 1000)) : 0
  return Math.max(age, apparentAge)
}

/**
 * Computes the entry's absolute times, or null when it shouldn't be stored.
 *
 * cachedAt is backdated by the corrected initial age so all downstream age
 * math (served Age header, freshness checks) reduces to `now - cachedAt`; the
 * origin Age header is stripped before storing to match.
 *
 * This cache does not retain entries past freshness for revalidation, so
 * deleteAt == staleAt: an entry is dropped by the store as soon as it goes
 * stale, and the read path never serves a stale entry. (The staleAt column
 * exists for forward compatibility with revalidation.) Everything is capped
 * by maxEntryTTL, measured from the (backdated) cachedAt.
 */
function computeEntryTimes(lifetime, age, maxEntryTTL, now) {
  if (!Number.isFinite(lifetime)) {
    return null
  }

  const freshness = Math.min(lifetime, maxEntryTTL) // seconds
  if (freshness - age <= 0) {
    // Stale on arrival — not worth storing.
    return null
  }

  const cachedAt = now - age * 1000
  const staleAt = cachedAt + freshness * 1000
  const deleteAt = staleAt

  return { cachedAt, staleAt, deleteAt }
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

  // Trace plumbing captured once at the dispatch entry: the resolved write fn
  // (null when tracing is off), the request id and the bounded url tag. One
  // `undici:cache-store` doc is emitted per response at the storability
  // outcome — no per-attempt emitted-flag is needed because every skip path
  // leaves #value null (making the stored/overflow paths unreachable for the
  // same attempt) and onConnect resets #value for retry re-entry.
  #write
  #id
  #url

  constructor(
    key,
    { store, logger, handler, maxEntrySize, maxEntryTTL, heuristic, defaultTTL, write, id, url },
  ) {
    super(handler)

    this.#key = key
    this.#logger = logger
    this.#value = null
    this.#store = store
    this.#maxEntrySize = maxEntrySize ?? store.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE
    this.#maxEntryTTL = maxEntryTTL ?? store.maxEntryTTL ?? DEFAULT_MAX_ENTRY_TTL
    this.#heuristic = heuristic ?? false
    this.#defaultTTL = defaultTTL ?? null
    this.#write = write ?? null
    this.#id = id ?? null
    this.#url = url ?? null
  }

  // The single `undici:cache-store` emitter. `err` is the raw error (or null);
  // tagging is deferred here so no string work happens unless tracing is on.
  #trace(statusCode, stored, reason, sizeBytes, ttlSec, err) {
    if (this.#write !== null) {
      traceSafe(
        this.#write,
        {
          id: this.#id,
          method: this.#key.method ?? null,
          url: this.#url,
          statusCode,
          stored,
          reason,
          sizeBytes,
          ttlSec,
          err: err != null ? traceErr(err) : null,
        },
        'undici:cache-store',
      )
    }
  }

  // Storability declined at header time: emit the skip doc and pass the
  // response through untouched. Keeps the many onHeaders early returns
  // single-line; `reason` names the failed gate and must stay low-cardinality.
  #skip(reason, statusCode, headers, resume) {
    this.#trace(statusCode, false, reason, null, null, null)
    return super.onHeaders(statusCode, headers, resume)
  }

  onConnect(abort) {
    this.#value = null

    super.onConnect((reason) => {
      // TODO (fix): Cache partial results?
      abort(reason)
    })
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode < 200) {
      // Interim informational responses precede the real response (raw undici
      // strips them, composed/mock dispatchers may forward them — same guard
      // as redirect/response-verify): not a storability outcome, so no
      // cache-store doc either — the final response emits the one doc.
      return super.onHeaders(statusCode, headers, resume)
    }

    if (statusCode !== 307 && statusCode !== 200 && statusCode !== 206) {
      return this.#skip('status', statusCode, headers, resume)
    }

    // 'trailer' is the RFC 9110 field name; 'trailers' is kept for backwards
    // compatibility with servers that misspell it.
    if (headers.vary === '*' || headers.trailer || headers.trailers) {
      // Not cacheble...
      return this.#skip(headers.vary === '*' ? 'vary-star' : 'trailer', statusCode, headers, resume)
    }

    if (headers['set-cookie']) {
      // Shared cache: replaying Set-Cookie to other clients leaks sessions.
      return this.#skip('set-cookie', statusCode, headers, resume)
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
        return this.#skip('content-range', statusCode, headers, resume)
      }
      if (this.#key.method === 'HEAD') {
        // A HEAD response delivers no body, so we never receive the byte
        // window Content-Range describes — storing it would fail the store's
        // body-length validation.
        return this.#skip('head-range', statusCode, headers, resume)
      }
    }

    let contentLength
    if (headers['content-length']) {
      contentLength = Number(headers['content-length'])
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        // We don't support caching responses with invalid content-length...
        return this.#skip('content-length', statusCode, headers, resume)
      }
    }

    if (statusCode === 206 && !contentRange) {
      // We don't support caching range responses without content-range...
      return this.#skip('206-no-range', statusCode, headers, resume)
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
        return this.#skip('auth', statusCode, headers, resume)
      }
    }

    // Unqualified private forbids shared-cache storage entirely; the
    // qualified form (private="field") only forbids storing the listed
    // fields, which are stripped below (RFC 9111 §5.2.2.7).
    if (cacheControlDirectives['no-store'] || cacheControlDirectives.private === true) {
      return this.#skip('no-store', statusCode, headers, resume)
    }

    if (cacheControlDirectives['must-understand']) {
      // Do nothing. We only cache responses that we understand...
    }

    if (cacheControlDirectives['no-transform']) {
      // Do nothing. We don't transform responses...
    }

    if (
      cacheControlDirectives['must-revalidate'] ||
      cacheControlDirectives['proxy-revalidate'] ||
      cacheControlDirectives['stale-while-revalidate'] != null ||
      cacheControlDirectives['stale-if-error'] != null ||
      cacheControlDirectives['no-cache'] === true
    ) {
      // These directives require origin revalidation, which this cache does
      // not yet perform — so the responses are not stored (a follow-up adds
      // conditional revalidation and turns these into stored-and-validated
      // entries).
      return this.#skip('revalidate', statusCode, headers, resume)
    }

    // Null prototype: selector names come from the response Vary header and
    // request header names are caller-controlled — on a plain `{}` a
    // `__proto__` key would hit the prototype setter and be silently dropped.
    const vary = Object.create(null)
    if (headers.vary) {
      if (typeof headers.vary !== 'string') {
        return this.#skip('vary-invalid', statusCode, headers, resume)
      }

      for (const key of headers.vary.split(',').map((key) => key.trim().toLowerCase())) {
        if (key === '*') {
          // RFC 9111 §4.1: a Vary field containing '*' never matches.
          return this.#skip('vary-star', statusCode, headers, resume)
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

    const lifetimeInfo = determineLifetime(
      statusCode,
      headers,
      cacheControlDirectives,
      { heuristic: this.#heuristic, defaultTTL: this.#defaultTTL },
      now,
    )
    if (lifetimeInfo == null) {
      return this.#skip('no-lifetime', statusCode, headers, resume)
    }

    const etag = typeof headers.etag === 'string' && isEtagUsable(headers.etag) ? headers.etag : ''
    const age = determineAge(headers, now)
    const times = computeEntryTimes(lifetimeInfo.lifetime, age, this.#maxEntryTTL, now)
    if (times == null) {
      return this.#skip('stale', statusCode, headers, resume)
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
    } else {
      return this.#skip('too-large', statusCode, headers, resume)
    }

    return super.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    if (this.#value) {
      this.#value.size += chunk.length
      this.#value.body.push(chunk)

      if (this.#value.size > this.#maxEntrySize) {
        // The buffer flips to discarded exactly once per attempt (#value stays
        // null afterwards), so this is the single skip emission for it.
        const statusCode = this.#value.statusCode
        this.#value = null
        this.#trace(statusCode, false, 'too-large', null, null, null)
      }
    }

    return super.onData(chunk)
  }

  onComplete(trailers) {
    if (this.#value && (!trailers || Object.keys(trailers).length === 0)) {
      this.#value.end ??= this.#value.start + this.#value.size
      let storeErr = null
      try {
        this.#store.set(this.#key, this.#value)
      } catch (err) {
        storeErr = err
        if (err.message === 'database is locked') {
          // Database is busy. We don't bother trying again...
          this.#logger?.debug({ err }, 'failed to set cache entry')
        } else {
          this.#logger?.error({ err }, 'failed to set cache entry')
        }
      }
      // stored reflects what actually happened: a throwing set() (e.g.
      // 'database is locked' under write contention) persisted nothing, and
      // dashboards keyed on `stored` must not count it. reason stays null —
      // this is a store failure, not a storability gate; err carries the why.
      this.#trace(
        this.#value.statusCode,
        storeErr == null,
        null,
        this.#value.size,
        Math.round((this.#value.staleAt - this.#value.cachedAt) / 1000),
        storeErr,
      )
      this.#value = null
    } else if (this.#value) {
      // Unexpected trailers arriving at completion decline storability late —
      // still one doc per response at the outcome.
      this.#trace(this.#value.statusCode, false, 'trailer', null, null, null)
    }

    super.onComplete(trailers)
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
  #write
  #id
  #url

  constructor(key, { store, logger, handler, write, id, url }) {
    super(handler)
    this.#key = key
    this.#store = store
    this.#logger = logger
    this.#write = write ?? null
    this.#id = id ?? null
    this.#url = url ?? null
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode >= 200 && statusCode <= 399) {
      // Invalidation failures must never break the actual response. Deletes
      // are idempotent, so a retry re-driving onHeaders is harmless.
      let paths = 0
      let invalidateErr = null
      try {
        paths = this.#invalidate(headers)
      } catch (err) {
        invalidateErr = err
        if (err.message === 'database is locked') {
          this.#logger?.debug({ err }, 'failed to invalidate cache entry')
        } else {
          this.#logger?.error({ err }, 'failed to invalidate cache entry')
        }
      }
      // One `undici:cache-invalidate` doc per settled invalidation; `paths` is
      // the count of invalidated paths, never the list.
      if (this.#write !== null) {
        traceSafe(
          this.#write,
          {
            id: this.#id,
            method: this.#key.method ?? null,
            url: this.#url,
            statusCode,
            paths,
            err: invalidateErr != null ? traceErr(invalidateErr) : null,
          },
          'undici:cache-invalidate',
        )
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

    return invalidated.size
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
  // parseHeaders first (which also lowercases the names). Header names are
  // caller-controlled, so parse into a null-prototype target: a `__proto__`
  // name on a plain `{}` would hit the Object.prototype setter instead of
  // becoming a data property.
  const key = undici.util.cache.makeCacheKey(
    Array.isArray(opts.headers)
      ? { ...opts, headers: parseHeaders(opts.headers, Object.create(null)) }
      : opts,
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

export default () => (dispatch) => (opts, handler) => {
  if (!opts.cache || opts.upgrade) {
    return dispatch(opts, handler)
  }

  // Capture-once per dispatch (log.js style): the same resolved fn drives the
  // `undici:cache` lookup doc and is threaded into CacheHandler /
  // InvalidationHandler for the store/invalidate docs, so a writer flipping
  // mid-request cannot split a dispatch across writers. Resolution cost when
  // tracing is off is one property read plus a typeof check.
  const write = traceWrite(opts.trace)

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

    const key = makeKey(opts)
    return dispatch(
      opts,
      new InvalidationHandler(key, {
        store,
        logger: opts.logger,
        handler,
        write,
        id: opts.id ?? null,
        url: write !== null ? traceUrl(key) : null,
      }),
    )
  }

  // TODO (fix): enable range requests

  const key = makeKey(opts)
  // Bounded url tag shared by every doc this dispatch emits; the key (not raw
  // opts) so the tag reflects the canonical path incl. the folded-in query.
  const url = write !== null ? traceUrl(key) : null

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

  // The lookup is timed only while tracing is on (performance.now() is not
  // free); a store get that throws is caught inside tryGetEntry and settles
  // as a miss with reason 'none'. `missReason` tracks which gate cleared a
  // returned entry so the eventual miss doc names it.
  let missReason = 'none'
  let lookupMs = null
  let entry
  if (write !== null) {
    const lookupStart = performance.now()
    entry = tryGetEntry(store, key, opts.logger)
    lookupMs = Math.round(performance.now() - lookupStart)
  } else {
    entry = tryGetEntry(store, key, opts.logger)
  }

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
      missReason = 'auth'
    }
  }

  const cacheHandler = () =>
    new CacheHandler(key, {
      ...cacheOptsOf(opts),
      store,
      logger: opts.logger,
      handler,
      write,
      id: opts.id ?? null,
      url,
    })

  // Request Cache-Control directives that this cache does not evaluate locally
  // (a follow-up adds conditional revalidation and local evaluation) cause a
  // bypass to the origin. These constrain REUSE of a stored response, not the
  // storage of a fresh one — so the bypass still writes the origin response
  // back through CacheHandler for later callers (undici PR #5510), unless the
  // request's own no-store forbids storing. only-if-cached is the exception:
  // it forbids contacting the origin, so it is handled from the cache below
  // instead of bypassing.
  const bypass =
    !onlyIfCached &&
    // != null: 'max-age=0' parses to 0 (falsy) but still demands revalidation.
    (requestCacheControl['max-age'] != null ||
      requestCacheControl['no-cache'] === true ||
      requestCacheControl['stale-if-error'] != null ||
      requestCacheControl['max-stale'] != null ||
      requestCacheControl['min-fresh'] != null)

  if (bypass) {
    if (write !== null) {
      // Name the (first, in evaluation order) directive that forced the
      // bypass; the fallthrough is min-fresh by construction of `bypass`.
      const reason =
        requestCacheControl['max-age'] != null
          ? 'max-age'
          : requestCacheControl['no-cache'] === true
            ? 'no-cache'
            : requestCacheControl['stale-if-error'] != null
              ? 'stale-if-error'
              : requestCacheControl['max-stale'] != null
                ? 'max-stale'
                : 'min-fresh'
      traceLookup(write, opts, url, 'bypass', reason, null, null, null, lookupMs)
    }
    return dispatch(opts, requestCacheControl['no-store'] ? handler : cacheHandler())
  }

  // RFC 9110 Section 13: evaluate conditional request headers against the
  // cached entry. The store only returns entries that are still fresh
  // (deleteAt === staleAt), so a returned entry is always servable.
  // typeof guards: duplicated conditional headers arrive as arrays — treat
  // them as non-matching and bypass to origin rather than crashing.
  if (entry && headers['if-none-match']) {
    if (
      typeof headers['if-none-match'] === 'string' &&
      entry.etag &&
      weakMatch(headers['if-none-match'], entry.etag)
    ) {
      return serveFromCache(
        { statusCode: 304, headers: entry.headers, cachedAt: entry.cachedAt },
        opts,
        handler,
        write,
        url,
        lookupMs,
      )
    }
    // Etag didn't match — bypass to origin.
    entry = undefined
    missReason = 'etag'
  } else if (entry && headers['if-modified-since']) {
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
        write,
        url,
        lookupMs,
      )
    }
    // No last-modified or modified since — bypass to origin.
    entry = undefined
    missReason = 'modified'
  }

  if (headers['if-match'] || headers['if-unmodified-since'] || headers['if-range']) {
    // TODO (fix): evaluate these conditional headers against cached entry.
    if (write !== null) {
      traceLookup(write, opts, url, 'bypass', 'conditional', null, null, null, lookupMs)
    }
    return dispatch(opts, handler)
  }

  if (!entry && !onlyIfCached) {
    if (write !== null) {
      traceLookup(write, opts, url, 'miss', missReason, null, null, null, lookupMs)
    }
    // A miss keeps the CacheHandler write-back unless the request's no-store
    // forbids storing.
    return dispatch(opts, requestCacheControl['no-store'] ? handler : cacheHandler())
  }

  // A hit (fresh, per the store) is served; only-if-cached with no usable
  // entry yields 504 (RFC 9111 §5.2.1.7) — the cache could NOT satisfy the
  // request, so its doc must not pollute hit-rate aggregations: it is a miss
  // the request forbade going to origin for.
  return entry
    ? serveFromCache(entry, opts, handler, write, url, lookupMs)
    : serveFromCache(
        { statusCode: 504 },
        opts,
        handler,
        write,
        url,
        lookupMs,
        'miss',
        'only-if-cached',
      )
}

/**
 * @param {'hit' | 'miss'} [result] lookup outcome for the undici:cache doc
 * @param {string | null} [reason]
 */
function serveFromCache(entry, opts, handler, write, url, lookupMs, result = 'hit', reason = null) {
  const { statusCode, trailers, body } = entry

  let headers = entry.headers
  let age = null
  if (entry.cachedAt != null) {
    // RFC 9111 §5.1: every response served from cache must carry an Age
    // header. cachedAt is backdated by the corrected initial age at store
    // time (§4.2.3) and the origin's Age header is stripped, so resident time
    // IS the response's age — no origin-Age addition. Date.now(), not
    // getFastNow(): the lagging clock would understate a relayed response's
    // initial age by up to a second.
    age = Math.max(0, Math.floor((Date.now() - entry.cachedAt) / 1000))
    headers = { ...headers, age: `${age}` }
  }

  // Entry serves and conditional 304s are lookup hits; the only-if-cached
  // synthetic 504 arrives as result 'miss' from the caller. Emitted before
  // onConnect and outside the try/catch below so trace code sits strictly
  // outside the handler-contract enforcement (traceSafe cannot throw, but
  // keep it out of that window anyway). Synthetic entries have no cachedAt,
  // so their ageSec stays null.
  if (write !== null) {
    traceLookup(write, opts, url, result, reason, statusCode, age, body?.byteLength ?? 0, lookupMs)
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
