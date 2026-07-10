// Store access and cache-key construction: the default (in-memory sqlite)
// store, the never-throw get wrapper, the shared get/set key builder and the
// per-request cache option extraction.
import undici from '@nxtedition/undici'
import { stringify } from 'fast-querystring'
import { parseHeaders } from '../../utils.js'
import { SqliteCacheStore } from '../../sqlite-cache-store.js'

let DEFAULT_STORE = null

const NOOP = () => {}

export function getStore(opts) {
  return opts.cache.store ?? (DEFAULT_STORE ??= new SqliteCacheStore({ location: ':memory:' }))
}

export function tryGetEntry(store, key, logger) {
  try {
    const entry = store.get(key)
    if (entry == null) {
      return undefined
    }
    // The CacheStore contract is synchronous. An async (Redis/fs-backed)
    // store's Promise is a truthy object whose every field reads undefined:
    // it would be treated as an entry, revalidated with the malformed
    // `if-modified-since: Invalid Date` on every request (never a hit), and
    // a REJECTED promise would escape every try/catch in the cache as an
    // unhandledRejection and kill the process. Detect, defuse, miss.
    if (typeof entry.then === 'function') {
      Promise.resolve(entry).then(NOOP, NOOP)
      logger?.error(
        {},
        'cache store get() returned a Promise; the CacheStore contract is synchronous',
      )
      return undefined
    }
    // set() receives the body as a chunk array (Buffer[]); get() must return
    // a single contiguous Buffer. A store that round-trips set() values
    // verbatim would otherwise silently serve EMPTY bodies on every hit
    // (serve.js gates on body.byteLength). Normalize inside the try so a
    // malformed array settles as a logged miss rather than escaping.
    if (Array.isArray(entry.body)) {
      entry.body = Buffer.concat(entry.body)
    }
    return entry
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
 * Write-side companion to tryGetEntry's thenable guard: set()/delete()
 * return values are ignored by contract, but an async store's REJECTED
 * promise would escape the call sites' synchronous try/catch as an
 * unhandledRejection and kill the process. Every store.set/store.delete in
 * the cache passes its result through here.
 */
export function ignoreStoreResult(result, logger) {
  if (result != null && typeof result.then === 'function') {
    Promise.resolve(result).then(NOOP, (err) => {
      logger?.error({ err }, 'async cache store write failed')
    })
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
      const lowerName = name.toLowerCase()
      const val = key.headers[name]
      const existing = lower[lowerName]
      if (existing === undefined) {
        lower[lowerName] = val
      } else {
        // Case-duplicate names ('Accept' and 'accept') are distinct keys on a
        // plain object but distinct header LINES on the wire (undici sends
        // both). Merge like parseHeaders does — last-wins would hide a value
        // from the Vary selectors (false-positive variant match) and from the
        // request-directive guards in index.js.
        lower[lowerName] = (Array.isArray(existing) ? existing : [existing]).concat(val)
      }
    }
    key.headers = lower
  }

  // The vendored makeCacheKey ignores opts.query. The wrapped pipeline is
  // immune (the query interceptor rewrites path before the cache sees it),
  // but a standalone interceptors.cache() composition would silently collide
  // distinct query strings onto one entry and serve the wrong response
  // (undici issue #4209 / PR #5081) — fold the query into the key path.
  if (opts.query && typeof key.path === 'string') {
    if (key.path.includes('?') || key.path.includes('#')) {
      // The same request shape undici and interceptors.query reject outright.
      // Proceeding with a query-less key would let a cache HIT mask that hard
      // error and serve content for a different logical resource.
      throw new Error('Query params cannot be passed when url already contains "?" or "#".')
    }
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
