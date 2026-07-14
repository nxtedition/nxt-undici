import undici from '@nxtedition/undici'
import { parsePriority, Scheduler } from '@nxtedition/scheduler'
import {
  buildAuthority,
  createNormalizedHeaders,
  invalidateNormalizedHeaders,
  isHttpProtocol,
  parseHeaders,
  validateAuthority,
} from './utils.js'
import { request as _request } from './request.js'
import { SqliteCacheStore } from './sqlite-cache-store.js'
import { validateTrace } from './trace.js'

const dispatcherCache = new WeakMap()
const dispatcherStatsRegistrySymbol = Symbol.for('@nxtedition/nxt-undici/dispatcher-stats/registry')
const dispatcherStatsProviderSymbol = Symbol.for('@nxtedition/nxt-undici/dispatcher-stats')
const dispatcherStatsRegistry =
  globalThis[dispatcherStatsRegistrySymbol] ??
  (globalThis[dispatcherStatsRegistrySymbol] = new Set())
const dispatcherStatsFinalizer = new FinalizationRegistry((ref) => {
  dispatcherStatsRegistry.delete(ref)
})
const proxyInterceptors = await import('./interceptor/proxy.js')

export const interceptors = {
  query: (await import('./interceptor/query.js')).default,
  requestBodyFactory: (await import('./interceptor/request-body-factory.js')).default,
  responseError: (await import('./interceptor/response-error.js')).default,
  responseRetry: (await import('./interceptor/response-retry.js')).default,
  responseVerify: (await import('./interceptor/response-verify.js')).default,
  log: (await import('./interceptor/log.js')).default,
  redirect: (await import('./interceptor/redirect.js')).default,
  proxy: proxyInterceptors.default,
  cache: (await import('./interceptor/cache/index.js')).default,
  requestId: (await import('./interceptor/request-id.js')).default,
  dns: (await import('./interceptor/dns.js')).default,
  lookup: (await import('./interceptor/lookup.js')).default,
  priority: (await import('./interceptor/priority.js')).default,
  pressure: (await import('./interceptor/pressure.js')).default,
}

export const cache = {
  SqliteCacheStore,
}

export { parseHeaders } from './utils.js'
export { SqliteCacheStore } from './sqlite-cache-store.js'
export { Client, Pool, Agent, getGlobalDispatcher, setGlobalDispatcher } from '@nxtedition/undici'

function defaultLookup(origin, opts, callback) {
  try {
    if (Array.isArray(origin)) {
      origin = origin[Math.floor(Math.random() * origin.length)]
    }

    // Note: not `else if` — an array element may itself be an object that
    // still needs normalizing to an origin string.
    if (origin != null && typeof origin === 'object') {
      const protocol = origin.protocol ?? 'http:'
      if (!isHttpProtocol(protocol)) {
        throw new Error('invalid url')
      }

      let host = origin.host
      if (host) {
        host = validateAuthority(protocol, host)
      }
      if (!host && origin.hostname) {
        host = buildAuthority(protocol, origin.hostname, origin.port)
      }

      if (!host) {
        throw new Error('invalid url')
      }

      origin = `${protocol}//${host}`
    }

    callback(null, origin)
  } catch (err) {
    callback(err, null)
  }
}

export function compose(...interceptors) {
  let dispatch = interceptors.shift()
  if (typeof dispatch?.dispatch === 'function') {
    dispatch = dispatch.dispatch.bind(dispatch)
  }

  for (const interceptor of interceptors) {
    if (interceptor == null) {
      continue
    }

    if (typeof interceptor !== 'function') {
      throw new TypeError(`invalid interceptor, expected function received ${typeof interceptor}`)
    }

    dispatch = interceptor(dispatch)

    if (dispatch == null || typeof dispatch !== 'function' || dispatch.length !== 2) {
      throw new TypeError('invalid interceptor')
    }
  }

  return dispatch
}

const PRIORITY_TOS = [0x04, 0x04, 0x04, 0x00, 0x68, 0x88, 0xb8]
const CACHE_STORE_COUNTERS = [
  'gets',
  'hits',
  'sets',
  'writes',
  'deletes',
  'flushes',
  'gcs',
  'clears',
  'evictions',
  'errors',
  'pending',
  'size',
  'usedSize',
  'maxSize',
]
const DNS_STATS = [
  'hits',
  'misses',
  'negativeHits',
  'lookups',
  'refreshes',
  'errors',
  'evictions',
  'pending',
]

export function getGlobalDispatcherStats() {
  const cacheStats = {
    hits: 0,
    misses: 0,
    revalidations: 0,
    bypasses: 0,
    hitRate: 0,
  }
  const storeStats = { stores: 0 }
  for (const counter of CACHE_STORE_COUNTERS) {
    storeStats[counter] = 0
  }
  const pressure = []
  const priority = []
  const redirect = { followed: 0 }
  const dns = Object.fromEntries(DNS_STATS.map((counter) => [counter, 0]))
  const lookup = { lookups: 0, errors: 0, pending: 0 }

  for (const ref of dispatcherStatsRegistry) {
    const dispatcher = ref.deref()
    if (dispatcher === undefined) {
      dispatcherStatsRegistry.delete(ref)
      continue
    }

    const stats = dispatcher.stats()
    for (const counter of ['hits', 'misses', 'revalidations', 'bypasses']) {
      cacheStats[counter] += stats.cache[counter]
    }
    if (stats.cache.store) {
      storeStats.stores += stats.cache.store.stores
      for (const counter of CACHE_STORE_COUNTERS) {
        storeStats[counter] += stats.cache.store[counter]
      }
    }
    pressure.push(...stats.pressure)
    priority.push(...stats.priority)
    redirect.followed += stats.redirect.followed
    for (const counter of DNS_STATS) {
      dns[counter] += stats.dns[counter]
    }
    for (const counter of ['lookups', 'errors', 'pending']) {
      lookup[counter] += stats.lookup[counter]
    }
  }

  const lookups = cacheStats.hits + cacheStats.misses
  cacheStats.hitRate = lookups === 0 ? 0 : cacheStats.hits / lookups
  if (storeStats.stores > 0) {
    storeStats.hitRate = storeStats.gets === 0 ? 0 : storeStats.hits / storeStats.gets
    cacheStats.store = storeStats
  }

  return { cache: cacheStats, pressure, priority, redirect, dns, lookup }
}

globalThis[dispatcherStatsProviderSymbol] = getGlobalDispatcherStats

function wrapDispatch(dispatcher) {
  let wrappedDispatcher = dispatcherCache.get(dispatcher)
  if (wrappedDispatcher == null) {
    const cache = interceptors.cache()
    const pressure = interceptors.pressure()
    const priority = interceptors.priority()
    const redirect = interceptors.redirect()
    const dns = interceptors.dns()
    const lookup = interceptors.lookup()
    wrappedDispatcher = compose(
      dispatcher,
      // The wrapped dispatcher is an arbitrary user boundary. It may retain or
      // mutate opts.headers, so remove the private normalization trust before
      // handing it over. DNS normally gives this boundary its own
      // snapshot; the invalidation is also required for dns:false/IP bypasses.
      (dispatch) => (opts, handler) => {
        invalidateNormalizedHeaders(opts.headers)
        return dispatch(opts, handler)
      },
      priority,
      dns,
      interceptors.requestBodyFactory(),
      // A retry strategy may legitimately mutate opts.headers, so every
      // actual attempt must cross the proxy's request boundary and have
      // hop-by-hop fields removed. The proxy builds a fresh header map, which
      // also prevents Via/Forwarded from accumulating between attempts.
      proxyInterceptors.proxyRequest(),
      interceptors.responseRetry(),
      interceptors.responseVerify(),
      // Observe logical-origin pressure outside retry but below the cache: a
      // cache hit creates no upstream load, while retries share one lifecycle
      // record and retain the caller-facing origin before DNS rewrites it.
      pressure,
      // Keep response filtering outside responseRetry. Retry must observe the
      // upstream Trailer field before the proxy strips it so it can disable
      // unsafe buffering/resumption for responses that announce trailers.
      proxyInterceptors.proxyResponse(),
      cache,
      redirect,
      // log also emits the undici:request trace start/end docs. Later entries
      // in this list wrap earlier ones, so it sits OUTSIDE everything that
      // does real work (redirect, cache, proxy, retry, dns) — durationMs
      // spans the whole inner pipeline including retries, dns and cache
      // lookups — but INSIDE requestId, so opts.id is already stamped and
      // the emitted docs correlate with logs and undici:retry docs by
      // request id.
      interceptors.log(),
      lookup,
      interceptors.requestId(),
      interceptors.responseError(),
      interceptors.query(),
      // Consume the parsed inbound request target once at the public boundary.
      // Every inner policy (log, redirect, cache, retry and DNS) must observe
      // the same origin-form path that will reach the transport.
      proxyInterceptors.proxyTarget(),
      (dispatch) => (opts, handler) => {
        if (!opts.origin) {
          throw new TypeError('opts.origin is required')
        }

        // Always take a fresh public-boundary snapshot. Even an object that
        // previously travelled through this package may since have escaped to
        // user code or be shared by another request.
        const headers = createNormalizedHeaders(opts.headers)

        const userAgent =
          opts.userAgent ?? globalThis.userAgent ?? globalThis.__nxt_undici_user_agent
        if (userAgent != null) {
          // Keep the trusted normalization invariant even for runtime callers
          // that bypass the string-only TypeScript contract.
          headers['user-agent'] ??= String(userAgent)
        }

        if (opts.priority != null) {
          headers['nxt-priority'] = String(opts.priority)
        }

        if (globalThis.__nxt_undici_global_headers) {
          // Run global headers through parseHeaders too, so they share the
          // pipeline invariant (lowercased names, stringified values) instead
          // of landing verbatim with mixed-case keys or non-string values.
          // parseHeaders into a fresh object keeps Object.assign's overwrite
          // semantics (its two-arg form would append instead).
          Object.assign(headers, parseHeaders(globalThis.__nxt_undici_global_headers))
        }

        // Use the same effective priority for both scheduler admission and
        // socket QoS. Header-derived priority is a supported path, including
        // duplicate last-wins values, and parsePriority provides the
        // scheduler's exact normalization for names, numbers and unknowns.
        const headerPriority = Array.isArray(headers['nxt-priority'])
          ? headers['nxt-priority'][headers['nxt-priority'].length - 1]
          : headers['nxt-priority']
        let priority = opts.priority ?? headerPriority
        let parsedPriority = Scheduler.NORMAL
        if (priority != null) {
          try {
            parsedPriority = parsePriority(priority)
          } catch {
            // Runtime callers can bypass the Priority type with values whose
            // numeric coercion throws. Keep both scheduling and QoS on normal
            // best-effort service instead of failing the request boundary.
            priority = parsedPriority
          }
        }

        return dispatch(
          {
            id: opts.id ?? headers['request-id'],
            origin: opts.origin,
            path: opts.path,
            method: opts.method ?? (opts.body != null ? 'POST' : 'GET'),
            body: opts.body,
            query: opts.query,
            headers,
            signal: opts.signal ?? undefined,
            reset: opts.reset ?? false,
            blocking: opts.blocking ?? true,
            // opts.timeout may be a number (applies to both phases) or an
            // object { headers, body }. The bare `?? opts.timeout` fallback must
            // only apply the SCALAR form — otherwise an object form that sets
            // just one of the two fields leaks the whole object into the other
            // timeout, which undici rejects with InvalidArgumentError.
            headersTimeout:
              opts.timeout?.headers ??
              opts.headersTimeout ??
              opts.headerTimeout ??
              (typeof opts.timeout === 'number' ? opts.timeout : undefined),
            bodyTimeout:
              opts.timeout?.body ??
              opts.bodyTimeout ??
              (typeof opts.timeout === 'number' ? opts.timeout : undefined),
            idempotent: opts.idempotent,
            typeOfService:
              opts.typeOfService ?? PRIORITY_TOS[parsedPriority - Scheduler.LOWEST] ?? 0,
            retry: opts.retry ?? 8,
            proxy: opts.proxy ?? false,
            cache: opts.cache ?? false,
            upgrade: opts.upgrade ?? false,
            follow: opts.follow ?? opts.redirect ?? 8,
            error: opts.error ?? opts.throwOnError ?? true,
            verify: opts.verify ?? { size: true, hash: false },
            logger: opts.logger ?? null,
            // Deliberately NOT defaulted: undefined means "fall back to the
            // per-thread writer installed via installTrace()" (resolved lazily
            // at each emission site — the writer may be installed after startup
            // and its `write` flips at runtime), null means "tracing disabled
            // for this request" (see lib/trace.js). Validation throws
            // InvalidArgumentError for anything that is not a writer.
            trace: validateTrace(opts.trace),
            dns: opts.dns ?? true,
            connect: opts.connect,
            priority,
            lookup: opts.lookup ?? defaultLookup,
          },
          handler,
        )
      },
    )
    wrappedDispatcher.stats = () => ({
      cache: cache.stats(),
      pressure: pressure.stats(),
      priority: priority.stats(),
      redirect: redirect.stats(),
      dns: dns.stats(),
      lookup: lookup.stats(),
    })
    const statsRef = new WeakRef(wrappedDispatcher)
    dispatcherStatsRegistry.add(statsRef)
    dispatcherStatsFinalizer.register(wrappedDispatcher, statsRef)
    dispatcherCache.set(dispatcher, wrappedDispatcher)
  }
  return wrappedDispatcher
}

export function dispatch(dispatcher, opts, handler) {
  return wrapDispatch(dispatcher)(opts, handler)
}

export function request(urlOrOpts, opts) {
  const opts2 =
    typeof urlOrOpts === 'object' && urlOrOpts != null && opts == null ? urlOrOpts : opts
  const dispatcher =
    opts2?.dispatch ??
    opts2?.dispatcher ??
    globalThis.__nxt_undici_dispatcher ??
    undici.getGlobalDispatcher()

  return _request(wrapDispatch(dispatcher), urlOrOpts, opts)
}
