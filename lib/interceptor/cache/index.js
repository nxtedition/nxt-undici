// The cache interceptor (read path): per-dispatch decision logic — lookup,
// request/response directive evaluation, conditional handling — delegating to
// the sibling modules: cache-handler.js (store/write path), revalidation.js
// (conditional revalidation + background refresh), invalidation-handler.js
// (unsafe-method invalidation), serve.js (delivery), freshness.js /
// headers.js (RFC 9111 math and header helpers) and store.js (key + store
// access).
import { parseCacheControl } from '../../utils.js'
import { traceWrite, traceUrl } from '../../trace.js'
import { CacheHandler } from './cache-handler.js'
import { forbidsServingStale } from './freshness.js'
import { conditionalHeaders, weakMatch } from './headers.js'
import { InvalidationHandler } from './invalidation-handler.js'
import { RevalidationHandler, backgroundRefresh } from './revalidation.js'
import { serveFromCache, traceLookup } from './serve.js'
import { cacheOptsOf, getStore, makeKey, tryGetEntry } from './store.js'

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
