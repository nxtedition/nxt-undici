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
// cache-revalidation.js imports helpers back from this module — a deliberate
// cycle. INVARIANT: every binding shared across the two files (in either
// direction) is referenced ONLY at call time, inside functions/methods, never
// during module evaluation. ESM live bindings resolve those by the time
// anything runs, so the cycle is safe. Do NOT use a cross-module import at
// top level (e.g. to initialize a module-scope const) or the binding will be
// in its TDZ and read as undefined.
import { RevalidationHandler, backgroundRefresh } from './cache-revalidation.js'
import { traceWrite, traceSafe, traceErr, traceUrl } from '../trace.js'

let DEFAULT_STORE = null
const DEFAULT_MAX_ENTRY_SIZE = 128 * 1024
export const DEFAULT_MAX_ENTRY_TTL = 30 * 24 * 3600 // seconds
// Bounded retention for entries kept solely for conditional revalidation
// (zero/expired freshness but a usable validator): long enough that the
// "always validate" origin pattern pays a 304 instead of a full 200, short
// enough not to pin dead content. Mirrors undici PR #5515 (24h).
const REVALIDATION_RETENTION = 24 * 3600 // seconds
// RFC 8246 'immutable' has no lifetime of its own; this is the customary
// 1-year default, capped by maxEntryTTL below.
const IMMUTABLE_LIFETIME = 31556952 // seconds
const NOOP = () => {}

/**
 * The single `undici:cache` lookup-doc emitter (read path). `write` is the
 * resolved trace fn (null when tracing is off), captured once per dispatch so
 * a writer flipping mid-request can't split a dispatch across writers.
 */
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
export function determineLifetime(
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
export function determineAge(headers, now) {
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
export function computeEntryTimes(
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
 * Builds the Vary selector map (RFC 9111 §4.1): for each field named in the
 * response Vary header, records the request's value (a null sentinel when the
 * header was absent — absent-vs-present is a mismatch, so an empty map must
 * NOT act as a wildcard). Selector names are lowercased and stored on a null
 * prototype: names come from the (server-controlled) Vary header, so a
 * `__proto__` entry on a plain `{}` would hit the Object.prototype setter and
 * be silently dropped.
 *
 * Returns null when the response is NOT cacheable on Vary grounds: a
 * non-string Vary (duplicated header lines) or a Vary containing '*' (which
 * never matches, RFC 9111 §4.1).
 *
 * @returns {Record<string, string | string[] | null> | null}
 */
export function parseVary(varyHeader, requestHeaders) {
  const vary = Object.create(null)
  if (varyHeader == null) {
    return vary
  }
  if (typeof varyHeader !== 'string') {
    return null
  }
  for (const name of varyHeader.split(',').map((key) => key.trim().toLowerCase())) {
    if (name === '*') {
      return null
    }
    if (name === '') {
      // Empty field-name (a bare/trailing comma, or `Vary:` with no value) is
      // not a selector — skip it so it can't become a spurious '' key.
      continue
    }
    vary[name] = requestHeaders[name] ?? null
  }
  return vary
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
export function conditionalHeaders(headers, entry) {
  // Null prototype, like every other header map this module builds (see
  // makeKey): the request header names are caller-controlled, so a plain `{}`
  // would expose Object.prototype (a `__proto__`/`constructor`/`toString`
  // field name reading through the chain instead of as absent) once these
  // headers flow back down the dispatch chain. Object.keys copies own fields
  // only; values are request header strings/arrays, copied by reference (the
  // shallow copy the previous spread also made).
  const condHeaders = Object.create(null)
  for (const name of Object.keys(headers)) {
    condHeaders[name] = headers[name]
  }
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

export class CacheHandler extends DecoratorHandler {
  #key
  #value
  #store
  #logger
  #maxEntrySize
  #maxEntryTTL
  #heuristic
  #defaultTTL
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
  // response through untouched. `reason` names the failed gate and must stay
  // low-cardinality.
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
      // Interim 1xx (e.g. 103 Early Hints) is not the final response — pass it
      // through with no store doc; the final response emits its own.
      return super.onHeaders(statusCode, headers, resume)
    }

    if (statusCode !== 307 && statusCode !== 200 && statusCode !== 206) {
      // A non-cacheable FINAL status (404, 500, ...): emit the skip doc so the
      // reason a response wasn't cached is visible, like every other gate.
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

    // must-revalidate / proxy-revalidate / unqualified no-cache /
    // stale-while-revalidate / stale-if-error responses ARE stored: the
    // directives constrain how the entry may be reused (validate first, never
    // serve stale, ...), which the read path enforces from the persisted
    // cacheControlDirectives.

    // parseVary returns null when the response can't be cached on Vary grounds:
    // a non-string (duplicated) Vary header, OR a member '*' inside a list (e.g.
    // `Vary: Accept, *`). The gate above only catches the bare `Vary: *`, so a
    // list containing '*' reaches — and is rejected by — parseVary here.
    const vary = parseVary(headers.vary, this.#key.headers)
    if (vary == null) {
      return this.#skip('vary-invalid', statusCode, headers, resume)
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
      return this.#skip('no-lifetime', statusCode, headers, resume)
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
      return super.onHeaders(statusCode, headers, resume)
    }

    // Known too-large at header time (Content-Length exceeds maxEntrySize): the
    // body is never buffered, so emit the skip doc now.
    return this.#skip('too-large', statusCode, headers, resume)
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
      // `stored` reflects what actually happened: a throwing set() (e.g.
      // 'database is locked') persisted nothing. `reason` stays null — this is
      // a store failure, not a storability gate; `err` carries the why.
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
      // Unexpected trailers decline storability late — still one doc per
      // response, at the outcome.
      this.#trace(this.#value.statusCode, false, 'trailer', null, null, null)
      this.#value = null
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
 *
 * INVARIANT: the key is scoped to the LOGICAL origin — `opts.origin` as the
 * caller requested it (scheme + host + port), never a DNS-resolved IP. HTTP
 * caching is defined over the target URI's authority (the host), so keying on
 * the physical IP would be wrong three ways: DNS round-robin would fragment
 * one resource across rotating IPs (hit-rate collapse); IP churn would orphan
 * entries; and — the real hazard — multiple hosts behind one IP (CDNs, shared
 * load balancers) would COLLIDE on a single key and serve each other's bodies
 * (cache poisoning). This holds because the cache interceptor runs BEFORE the
 * dns interceptor that rewrites `opts.origin` to the resolved IP (dns pins the
 * Host header and resolves for the connection only, below the cache). A
 * composition that places an origin→IP rewrite ABOVE the cache would break
 * this — keep the cache outboard of DNS resolution.
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

export function cacheOptsOf(opts) {
  return {
    maxEntrySize: opts.cache.maxEntrySize,
    maxEntryTTL: opts.cache.maxEntryTTL,
    heuristic: opts.cache.heuristic,
    defaultTTL: opts.cache.defaultTTL,
  }
}

/**
 * Validates the optional `origins` whitelist (undici PR #4739): undefined (the
 * default) caches every origin; otherwise it must be an array of strings or
 * RegExps. Thrown at interceptor construction so misconfiguration fails fast.
 */
function assertCacheOrigins(origins, name) {
  if (origins === undefined) {
    return
  }
  if (!Array.isArray(origins)) {
    throw new TypeError(`expected ${name} to be an array or undefined, got ${typeof origins}`)
  }
  for (let i = 0; i < origins.length; i++) {
    const origin = origins[i]
    if (typeof origin !== 'string' && !(origin instanceof RegExp)) {
      throw new TypeError(`expected ${name}[${i}] to be a string or RegExp, got ${typeof origin}`)
    }
  }
}

/**
 * Whether the request origin is permitted by the whitelist. String entries
 * match the whole origin case-insensitively; RegExp entries are tested against
 * it. An empty array matches nothing (caches no origin).
 */
function originAllowed(origin, origins) {
  const requestOrigin = `${origin}`.toLowerCase()
  for (const allowed of origins) {
    if (typeof allowed === 'string') {
      if (allowed.toLowerCase() === requestOrigin) {
        return true
      }
    } else {
      // RegExp#test advances lastIndex for global/sticky (g/y) patterns, so a
      // reused whitelist RegExp would match intermittently across requests.
      // Reset first (a no-op for non-g/y patterns) to keep matching stateless.
      allowed.lastIndex = 0
      if (allowed.test(requestOrigin)) {
        return true
      }
    }
  }
  return false
}

export default ({ origins } = {}) => {
  assertCacheOrigins(origins, 'opts.origins')
  return (dispatch) => (opts, handler) => {
    if (!opts.cache || opts.upgrade) {
      return dispatch(opts, handler)
    }

    // RFC-agnostic policy gate (undici PR #4739): when an origins whitelist is
    // configured, a request to any other origin bypasses the cache entirely —
    // neither stored/served nor invalidated.
    if (origins !== undefined && !originAllowed(opts.origin, origins)) {
      return dispatch(opts, handler)
    }

    // Capture-once per dispatch (log.js style): the same resolved fn drives the
    // `undici:cache` lookup doc and is threaded into CacheHandler /
    // InvalidationHandler / RevalidationHandler for the store/invalidate docs,
    // so a writer flipping mid-request cannot split a dispatch across writers.
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

      const invKey = makeKey(opts)
      return dispatch(
        opts,
        new InvalidationHandler(invKey, {
          store,
          logger: opts.logger,
          handler,
          write,
          id: opts.id ?? null,
          url: write !== null ? traceUrl(invKey) : null,
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
    // free); a store get that throws settles as a miss inside tryGetEntry.
    // `missReason` tracks which gate cleared a returned entry so the eventual
    // miss doc names it.
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
    // Whole-second, non-negative age — the SAME value serveFromCache emits as the
    // Age header. RFC 9111 directives are delta-seconds (integers), so evaluating
    // max-age against a fractional age would reject an entry (e.g. 10.2s vs
    // max-age=10) that the client sees as within bound via `Age: 10`.
    const ageSeconds = entry == null ? 0 : Math.max(0, Math.floor((now - entry.cachedAt) / 1000))
    const requestAccepts =
      entry == null ||
      // Bounds are inclusive (RFC 9111 §5.2.1.1/§5.2.1.3): the client accepts an
      // age that does NOT exceed max-age (age <= max-age) and freshness lasting
      // AT LEAST min-fresh (remaining >= min-fresh). Strict comparisons would
      // spuriously revalidate at the exact boundary (e.g. age == max-age).
      //
      // max-age=0 is the deliberate exception: it always forces revalidation
      // (the fetch cache:'no-cache' idiom, undici #5504) and must not accept an
      // age-0 entry, so it is excluded from the inclusive form via `> 0`. The
      // `== null` guard also keeps 0 (falsy) from being read as "absent".
      ((requestCacheControl['max-age'] == null ||
        (requestCacheControl['max-age'] > 0 && ageSeconds <= requestCacheControl['max-age'])) &&
        (requestCacheControl['min-fresh'] == null ||
          entry.staleAt - now >= requestCacheControl['min-fresh'] * 1000))
    const fresh = entry != null && now < entry.staleAt && requestAccepts

    // Validation demanded regardless of freshness: the request's no-cache (or
    // Pragma), or the stored response's unqualified no-cache (§5.2.2.4).
    //
    // Request no-cache: `!= null` (any presence), not `=== true`. The request
    // directive has no qualified form (RFC 9111 §5.2.1.4), but a client sending
    // the malformed `no-cache="field"` parses to an array — fail safe and treat
    // ANY presence as "must revalidate" rather than serving without validation.
    // Response no-cache stays `=== true`: only the UNQUALIFIED response form
    // forces full revalidation; the qualified `no-cache="field"` form is a
    // field-strip directive (§5.2.2.4), handled at store/freshen time.
    const mustRevalidate =
      entry != null &&
      (requestCacheControl['no-cache'] != null ||
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
          write,
          url,
          lookupMs,
        )
      }
      // Etag didn't match — bypass to origin.
      entry = undefined
      missReason = 'etag'
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
          write,
          url,
          lookupMs,
        )
      }
      // No last-modified or modified since — bypass to origin.
      entry = undefined
      missReason = 'modified'
    } else if (entry && (headers['if-none-match'] || headers['if-modified-since'])) {
      // Stale (or validation-demanding) entry + caller conditionals: forward to
      // origin so the caller's own validators do the validation.
      entry = undefined
      missReason = 'conditional'
    }

    if (headers['if-match'] || headers['if-unmodified-since'] || headers['if-range']) {
      // TODO (fix): evaluate these conditional headers against cached entry.
      if (write !== null) {
        traceLookup(write, opts, url, 'bypass', 'conditional', null, null, null, lookupMs)
      }
      return dispatch(opts, handler)
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

    if (!entry) {
      if (onlyIfCached) {
        // RFC 9111 §5.2.1.7: no stored response usable without contacting the
        // origin — 504. Not a hit: it is a miss the request forbade origin for.
        return serveFromCache(
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
      // Request directives (no-cache, max-age, ...) constrain REUSE of a stored
      // response, not storage of a fresh one (undici PR #5510): every miss path
      // keeps the CacheHandler write-back so one client's freshness override
      // doesn't disable caching of the URL for everyone. Only the request's
      // no-store forbids storing.
      if (write !== null) {
        traceLookup(write, opts, url, 'miss', missReason, null, null, null, lookupMs)
      }
      return dispatch(opts, requestCacheControl['no-store'] ? handler : cacheHandler())
    }

    if (fresh && !mustRevalidate) {
      return serveFromCache(entry, opts, handler, write, url, lookupMs)
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
      return serveFromCache(entry, opts, handler, write, url, lookupMs)
    }

    if (onlyIfCached) {
      // Stale (or validation-demanding) entry and the origin is off-limits.
      return serveFromCache(
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

    if (entry.statusCode === 206) {
      // Range entries can't be revalidated as a whole representation — refetch.
      if (write !== null) {
        traceLookup(write, opts, url, 'miss', '206', null, null, null, lookupMs)
      }
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
        serveFromCache(entry, opts, handler, write, url, lookupMs)
      } finally {
        // RFC 9111 §5.2.1.5: a request no-store forbids storing ANY response to
        // it, and the background refresh's sole effect is to write the store —
        // so skip it entirely (issuing a fetch we couldn't store is pure waste).
        if (!requestCacheControl['no-store']) {
          backgroundRefresh(dispatch, opts, key, store, entry)
        }
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
        // `!= null` (any presence), matching the truthy no-store checks on the
        // miss/SWR paths above: a malformed qualified `no-store="field"` (array)
        // must still suppress storing the revalidation replacement, not slip
        // through a stricter `=== true`.
        noStore: requestCacheControl['no-store'] != null,
        cacheOpts: cacheOptsOf(opts),
        write,
        id: opts.id ?? null,
        url,
        lookupMs,
      }),
    )
  }
}

export function serveFromCache(
  entry,
  opts,
  handler,
  write = null,
  url = null,
  lookupMs = null,
  result = 'hit',
  reason = null,
) {
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
  // synthetic 504 arrives as result 'miss' from the caller. Synthetic entries
  // have no cachedAt, so their ageSec stays null. Emitted before onConnect.
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
export function isEtagUsable(etag) {
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
