// Store access and cache-key construction: the default (in-memory sqlite)
// store, the never-throw get wrapper, the shared get/set key builder and the
// per-request cache option extraction.
import { stringify } from 'fast-querystring'
import { parseHeaders } from '../../utils.js'
import { SqliteCacheStore } from '../../sqlite-cache-store.js'

let DEFAULT_STORE = null

export function getStore(opts) {
  return opts.cache.store ?? (DEFAULT_STORE ??= new SqliteCacheStore({ location: ':memory:' }))
}

/**
 * RFC 9110 §4.2.3 origin normalization: equivalent target URIs must share one
 * cache key. Cache-key construction stringifies `opts.origin` verbatim, so the
 * SAME logical origin fragments into distinct entries — costing hits and
 * duplicating storage — when callers vary the scheme/host case, spell out the
 * default port, or pass a URL object (whose `toString()` appends a trailing `/`)
 * vs a bare string:
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

// Ignore an iterator polluted onto Object.prototype while retaining real own
// and inherited iterators (Headers, Map and custom iterable header containers).
function hasSafeIterator(value) {
  if (value == null || value === Object.prototype) {
    return false
  }

  if (Object.hasOwn(value, Symbol.iterator)) {
    return typeof value[Symbol.iterator] === 'function'
  }

  let owner = Object.getPrototypeOf(value)
  while (owner != null && owner !== Object.prototype) {
    if (Object.hasOwn(owner, Symbol.iterator)) {
      return typeof value[Symbol.iterator] === 'function'
    }
    owner = Object.getPrototypeOf(owner)
  }

  return false
}

function normalizeKeyHeaders(headers) {
  if (headers == null) {
    return Object.create(null)
  }

  let parsed

  // Arrays are the undici flat name/value form. `parseHeaders` handles Buffer
  // names/values, duplicate fields, nullish values and casing consistently.
  if (Array.isArray(headers)) {
    parsed = parseHeaders(headers)
  } else {
    if (typeof headers !== 'object') {
      throw new Error('opts.headers is not an object')
    }

    if (hasSafeIterator(headers)) {
      const flat = []
      for (const entry of headers) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw new Error('opts.headers is not a valid header map')
        }
        flat.push(entry[0], entry[1])
      }
      parsed = parseHeaders(flat)
    } else {
      parsed = parseHeaders(headers)
    }
  }

  // Header names are caller-controlled, so return a fresh null-prototype
  // snapshot. This also makes `__proto__` an ordinary data property.
  return Object.assign(Object.create(null), parsed)
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
  if (!opts.origin) {
    throw new Error('opts.origin is missing')
  }

  // Own the complete cache-key contract here instead of coupling this cache to
  // an undici utility export. The same builder serves lookups and stores, so URL
  // objects, a missing root path and every supported header representation are
  // normalized identically on both paths.
  const key = {
    origin: String(opts.origin),
    method: opts.method ?? (opts.body != null ? 'POST' : 'GET'),
    path: opts.path || '/',
    headers: normalizeKeyHeaders(opts.headers),
  }

  // Canonicalize equivalent target URIs onto one key (RFC 9110 §4.2.3): scheme
  // /host case and default ports must not fragment the cache. `key.origin` is
  // already stringified, so this normalizes both the get and set paths
  // identically.
  key.origin = normalizeOrigin(key.origin)

  // Core key construction deliberately handles opts.query here. The wrapped
  // pipeline is immune (the query interceptor rewrites path before the cache sees it),
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
