import net from 'node:net'
import undici from '@nxtedition/undici'
import { Scheduler } from '@nxtedition/scheduler'
import { parseHeaders } from './utils.js'
import { request as _request } from './request.js'
import { SqliteCacheStore } from './sqlite-cache-store.js'

const dispatcherCache = new WeakMap()

export const interceptors = {
  query: (await import('./interceptor/query.js')).default,
  requestBodyFactory: (await import('./interceptor/request-body-factory.js')).default,
  responseError: (await import('./interceptor/response-error.js')).default,
  responseRetry: (await import('./interceptor/response-retry.js')).default,
  responseVerify: (await import('./interceptor/response-verify.js')).default,
  log: (await import('./interceptor/log.js')).default,
  redirect: (await import('./interceptor/redirect.js')).default,
  proxy: (await import('./interceptor/proxy.js')).default,
  cache: (await import('./interceptor/cache.js')).default,
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
export { Client, Pool, Agent, getGlobalDispatcher, setGlobalDispatcher } from '@nxtedition/undici'

function defaultLookup(origin, opts, callback) {
  try {
    if (Array.isArray(origin)) {
      origin = origin[Math.floor(Math.random() * origin.length)]
    }

    // Note: not `else if` — an array element may itself be an object that
    // still needs normalizing to an origin string.
    if (origin != null && typeof origin === 'object') {
      const protocol = origin.protocol || 'http:'

      let host = origin.host
      if (!host && origin.hostname) {
        const port = origin.port || (protocol === 'https:' ? 443 : 80)
        // Bracket IPv6 literals, otherwise `::1:80` is not a valid authority.
        const hostname = net.isIPv6(origin.hostname) ? `[${origin.hostname}]` : origin.hostname
        host = `${hostname}:${port}`
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

const PRIORITY_TOS_MAP = {}
PRIORITY_TOS_MAP[Scheduler.HIGHEST] = 0xb8 // EF
PRIORITY_TOS_MAP['highest'] = 0xb8 // EF
PRIORITY_TOS_MAP[Scheduler.HIGHER] = 0x88 // AF41
PRIORITY_TOS_MAP['higher'] = 0x88 // AF41
PRIORITY_TOS_MAP[Scheduler.HIGH] = 0x68 // AF31
PRIORITY_TOS_MAP['high'] = 0x68 // AF31
PRIORITY_TOS_MAP[Scheduler.NORMAL] = 0x00 // BE
PRIORITY_TOS_MAP['normal'] = 0x00 // BE
PRIORITY_TOS_MAP[Scheduler.LOW] = 0x04 // LE
PRIORITY_TOS_MAP['low'] = 0x04 // LE
PRIORITY_TOS_MAP[Scheduler.LOWER] = 0x04 // LE
PRIORITY_TOS_MAP['lower'] = 0x04 // LE
PRIORITY_TOS_MAP[Scheduler.LOWEST] = 0x04 // LE
PRIORITY_TOS_MAP['lowest'] = 0x04 // LE

function wrapDispatch(dispatcher) {
  let wrappedDispatcher = dispatcherCache.get(dispatcher)
  if (wrappedDispatcher == null) {
    wrappedDispatcher = compose(
      dispatcher,
      interceptors.priority(),
      interceptors.dns(),
      interceptors.requestBodyFactory(),
      interceptors.responseRetry(),
      interceptors.responseVerify(),
      interceptors.proxy(),
      interceptors.cache(),
      interceptors.redirect(),
      interceptors.log(),
      interceptors.lookup(),
      interceptors.requestId(),
      interceptors.responseError(),
      interceptors.query(),
      (dispatch) => (opts, handler) => {
        if (!opts.origin) {
          throw new TypeError('opts.origin is required')
        }

        const headers = parseHeaders(opts.headers)

        const userAgent =
          opts.userAgent ?? globalThis.userAgent ?? globalThis.__nxt_undici_user_agent
        if (userAgent != null) {
          headers['user-agent'] ??= userAgent
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

        return dispatch(
          {
            id: opts.id ?? headers['request-id'],
            origin: opts.origin,
            path: opts.path,
            method: opts.method ?? (opts.body ? 'POST' : 'GET'),
            body: opts.body,
            query: opts.query,
            headers,
            signal: opts.signal ?? undefined,
            reset: opts.reset ?? false,
            blocking: opts.blocking ?? true,
            headersTimeout:
              opts.timeout?.headers ?? opts.headersTimeout ?? opts.headerTimeout ?? opts.timeout,
            bodyTimeout: opts.timeout?.body ?? opts.bodyTimeout ?? opts.timeout,
            idempotent: opts.idempotent,
            typeOfService:
              opts.typeOfService ?? (opts.priority ? (PRIORITY_TOS_MAP[opts.priority] ?? 0) : 0),
            retry: opts.retry ?? 8,
            proxy: opts.proxy ?? false,
            cache: opts.cache ?? false,
            upgrade: opts.upgrade ?? false,
            follow: opts.follow ?? opts.redirect ?? 8,
            error: opts.error ?? opts.throwOnError ?? true,
            verify: opts.verify ?? { size: true, hash: false },
            logger: opts.logger ?? null,
            dns: opts.dns ?? true,
            connect: opts.connect,
            // A duplicated nxt-priority request header parses to an array; the
            // scheduler and PRIORITY_TOS_MAP expect a scalar, so take the last
            // (last-wins). opts.priority, when set, is already scalar.
            priority:
              opts.priority ??
              (Array.isArray(headers['nxt-priority'])
                ? headers['nxt-priority'][headers['nxt-priority'].length - 1]
                : headers['nxt-priority']),
            lookup: opts.lookup ?? defaultLookup,
          },
          handler,
        )
      },
    )
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
