// Store access and cache-key construction: the default (in-memory sqlite)
// store, the never-throw get wrapper, the shared get/set key builder and the
// per-request cache option extraction.
import undici from '@nxtedition/undici'
import { stringify } from 'fast-querystring'
import { parseHeaders } from '../../utils.js'
import { SqliteCacheStore } from '../../sqlite-cache-store.js'

let DEFAULT_STORE = null

export function getStore(opts) {
  return opts.cache.store ?? (DEFAULT_STORE ??= new SqliteCacheStore({ location: ':memory:' }))
}

/**
 * RFC 9110 §4.2.3 origin normalization: equivalent target URIs must share one
 * cache key. `makeCacheKey` stringifies `opts.origin` verbatim, so the SAME
 * logical origin fragments into distinct entries — costing hits and duplicating
 * storage — when callers vary the scheme/host case, spell out the default port,
 * or pass a URL object (whose `toString()` appends a trailing `/`) vs a bare
 * string:
 *
 *   https://example.com  ==  https://example.com:443  ==  HTTPS://EXAMPLE.COM
 *   new URL('https://example.com')  ->  'https://example.com/'
 *
 * `URL#origin` collapses all of these: it lowercases the scheme and host and
 * elides the scheme's default port, yielding a canonical `scheme://host[:port]`
 * with no trailing slash or userinfo. Non-special schemes (and anything
 * unparseable) expose a `'null'` opaque origin — keep the caller's raw value
 * there rather than collapsing distinct origins onto the literal string
 * `'null'`. Applied once in makeKey so the get and set paths key identically
 * (and traceUrl, fed the key, tags the canonical origin too).
 *
 * Always returns a string: the input is coerced up front so the fallback path
 * (unparseable / opaque origin) can't hand a URL object or other non-string
 * back to callers doing string operations on the result.
 */
export function normalizeOrigin(origin) {
  const raw = String(origin)
  try {
    const normalized = new URL(raw).origin
    if (normalized && normalized !== 'null') {
      return normalized
    }
  } catch {
    // Not a parseable absolute URL — key on the caller's value verbatim.
  }
  return raw
}

export function tryGetEntry(store, key, logger) {
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
export function makeKey(opts) {
  // Build the key the same way for lookups and stores: makeCacheKey
  // stringifies the origin (e.g. URL objects), so using raw opts on the get
  // path while the set path normalizes would make the cache permanently miss.
  // The flat name/value array form of opts.headers (legal at the undici
  // client level) makes makeCacheKey throw — normalize it through
  // parseHeaders first (which also lowercases the names). Header names are
  // caller-controlled, so copy the normalized result into a null-prototype
  // target before passing it to undici's cache-key builder.
  const key = undici.util.cache.makeCacheKey(
    Array.isArray(opts.headers)
      ? {
          ...opts,
          headers: Object.assign(Object.create(null), parseHeaders(opts.headers)),
        }
      : opts,
  )

  // Canonicalize equivalent target URIs onto one key (RFC 9110 §4.2.3): scheme
  // /host case and default ports must not fragment the cache. `key.origin` is
  // the stringified origin makeCacheKey produced, so this normalizes both the
  // get and set paths identically.
  if (typeof key.origin === 'string') {
    key.origin = normalizeOrigin(key.origin)
  }

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
