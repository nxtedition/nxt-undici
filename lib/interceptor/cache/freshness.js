// RFC 9111 freshness and retention math: how long a response is fresh, how
// old it arrived, and the absolute cachedAt/staleAt/deleteAt times an entry
// is stored with. Pure functions of headers/directives and a caller-supplied
// clock — no store or handler state.
import { parseHttpDate } from '../../utils.js'

export const DEFAULT_MAX_ENTRY_TTL = 30 * 24 * 3600 // seconds
// Bounded retention for entries kept solely for conditional revalidation
// (zero/expired freshness but a usable validator): long enough that the
// "always validate" origin pattern pays a 304 instead of a full 200, short
// enough not to pin dead content. Mirrors undici PR #5515 (24h).
const REVALIDATION_RETENTION = 24 * 3600 // seconds

/**
 * Explicit (or opt-in heuristic/policy) freshness lifetime in seconds, or null
 * when the response carries no usable expiration information. RFC 9111 §4.2.1
 * priority for a shared cache: s-maxage > max-age > Expires; when none is
 * present, the opt-in heuristic (Last-Modified) or a configured defaultTTL may
 * apply (200 only — see below). `explicit` marks origin-provided expiration —
 * required for the stale-on-arrival store-and-revalidate path (never keep
 * heuristically-stale content around for revalidation).
 *
 * RFC 8246 'immutable' is deliberately NOT a freshness source: §2 says it
 * applies DURING the response's freshness lifetime and neither defines nor
 * extends it (a stale immutable response is revalidated normally). It only
 * lets a cache skip revalidation while an INDEPENDENTLY determined lifetime is
 * still fresh — an optional optimization — so it never yields a lifetime here.
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
    const expires =
      typeof headers.expires === 'string' ? parseHttpDate(headers.expires, now) : undefined
    if (!expires) {
      return { lifetime: 0, explicit: true }
    }
    const date = typeof headers.date === 'string' ? parseHttpDate(headers.date, now) : undefined
    return {
      lifetime: Math.floor((expires.getTime() - (date ? date.getTime() : now)) / 1000),
      explicit: true,
    }
  }

  // The cache-INVENTED lifetimes below (heuristic from Last-Modified,
  // configured defaultTTL) are restricted to plain 200s: inventing a lifetime
  // for a 206/redirect/404 without origin consent would cache partials,
  // redirects and errors on the cache's own initiative, which is why a non-200
  // status is storable only on an origin-driven signal (explicit freshness
  // above, or the unqualified no-cache store-and-revalidate path in
  // CacheHandler). Extending the heuristic to the other heuristically-cacheable
  // statuses (301/308/404/410, RFC 9110 §15.1) would be RFC-permissible but is
  // deliberately declined here as a conservative implementation policy.
  if (statusCode === 200) {
    if (heuristic && typeof headers['last-modified'] === 'string') {
      // RFC 9111 §4.2.2 suggested heuristic: 10% of time since Last-Modified.
      // §4.2.2 forbids heuristics when an explicit expiration exists; Expires
      // was handled (including the invalid form) above, so this is reached
      // only when none does.
      const lastModified = parseHttpDate(headers['last-modified'], now)
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
 * Corrected initial age in whole seconds per RFC 9111 §4.2.3: the larger of
 * apparent age (response receipt time minus the origin Date) and corrected
 * age (the Age header plus request-to-response delay). Age is relative to
 * request initiation, so omitting response_delay over-extends freshness by
 * the entire upstream round trip for a slow response.
 */
export function determineAge(headers, responseTime, requestTime = responseTime) {
  const rawAge = headers.age
  // A duplicated Age header arrives as an array; take the first value. A
  // single line may still carry a (malformed) list — `Age: 7200, 0` — and the
  // first member wins there too, matching the field-combining order of the
  // duplicated form (http-tests/cache-tests age-parse-suffix/-prefix).
  let rawAgeValue = Array.isArray(rawAge) ? rawAge[0] : rawAge
  if (typeof rawAgeValue === 'string' && rawAgeValue.includes(',')) {
    rawAgeValue = rawAgeValue.slice(0, rawAgeValue.indexOf(','))
  }
  // RFC 9111 §5.1 Age is delta-seconds (1*DIGIT): require a pure integer so a
  // malformed value like "5junk" isn't parseInt-coerced to 5 and used to
  // backdate cachedAt / extend staleness.
  const age =
    typeof rawAgeValue === 'string' && /^\d+$/.test(rawAgeValue.trim())
      ? parseInt(rawAgeValue, 10)
      : 0
  const date =
    typeof headers.date === 'string' ? parseHttpDate(headers.date, responseTime) : undefined
  const apparentAge = date ? Math.max(0, Math.floor((responseTime - date.getTime()) / 1000)) : 0
  const responseDelay = Math.max(0, Math.floor((responseTime - requestTime) / 1000))
  return Math.max(age + responseDelay, apparentAge)
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

  const swr = cacheControlDirectives['stale-while-revalidate']
  const sie = cacheControlDirectives['stale-if-error']
  // Widest origin-granted stale-serving window, for the storability gate
  // below: RFC 5861 SWR/SIE need no validator (their value is serving stale
  // immediately), so a response arriving already stale but still inside its
  // window is worth storing even validator-less.
  const staleWindow = Math.max(
    typeof swr === 'number' && swr > 0 ? swr : 0,
    typeof sie === 'number' && sie > 0 ? sie : 0,
  )

  if (freshness - age <= 0 && !(explicit && (hasValidator || freshness + staleWindow - age > 0))) {
    // Stale on arrival, no cheap way to revalidate and no origin-granted
    // stale window left — not worth storing.
    return null
  }

  const cachedAt = now - age * 1000
  const staleAt = cachedAt + freshness * 1000
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
export function forbidsServingStale(entry) {
  const directives = entry.cacheControlDirectives
  return directives?.['must-revalidate'] === true || directives?.['proxy-revalidate'] === true
}

/**
 * RFC 9111 §5.2.2.10: s-maxage additionally implies proxy-revalidate
 * semantics for a shared cache, and §4.2.4 lists an applicable s-maxage among
 * the directives prohibiting a stale response. The implication vetoes only
 * the REQUEST-driven relaxations (max-stale, the request stale-if-error
 * fallback): the origin's own stale-while-revalidate / stale-if-error sent
 * ALONGSIDE s-maxage is an explicit grant and stays honored (the canonical
 * CDN idiom `s-maxage=N, stale-while-revalidate=M`).
 */
export function forbidsRequestDrivenStale(entry) {
  return forbidsServingStale(entry) || entry.cacheControlDirectives?.['s-maxage'] != null
}
