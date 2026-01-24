import undici from '@nxtedition/undici'
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
    } else if (origin != null && typeof origin === 'object') {
      const protocol = origin.protocol || 'http:'

      let host = origin.host
      if (!host && origin.hostname) {
        const port = origin.port || (protocol === 'https:' ? 443 : 80)
        host = `${origin.hostname}:${port}`
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

function wrapDispatch(dispatcher) {
  let wrappedDispatcher = dispatcherCache.get(dispatcher)
  if (wrappedDispatcher == null) {
    wrappedDispatcher = compose(
      dispatcher,
      interceptors.priority(),
      interceptors.dns(),
      interceptors.lookup(),
      interceptors.requestBodyFactory(),
      interceptors.responseRetry(),
      interceptors.responseVerify(),
      interceptors.proxy(),
      interceptors.cache(),
      interceptors.redirect(),
      interceptors.log(),
      interceptors.requestId(),
      interceptors.responseError(),
      interceptors.query(),
      (dispatch) => (opts, handler) => {
        if (!opts.origin) {
          throw new TypeError('opts.origin is required')
        }

        const headers = parseHeaders(opts.headers)

        // TODO (fix): Move to interceptor?
        headers['user-agent'] ??=
          opts.userAgent ?? globalThis.userAgent ?? globalThis.__nxt_undici_user_agent

        let priority
        if (opts.priority == null) {
          // Do nothing
        } else if (opts.priority === 'low' || opts.priority === 0 || opts.priority === '0') {
          headers['nxt-priority'] = 'low'
          priority = 0
        } else if (opts.priority === 'normal' || opts.priority === 1 || opts.priority === '1') {
          headers['nxt-priority'] = 'normal'
          priority = 1
        } else if (opts.priority === 'high' || opts.priority === 2 || opts.priority === '2') {
          headers['nxt-priority'] = 'high'
          priority = 2
        } else {
          throw new TypeError('invalid opts.priority')
        }

        if (priority == null && headers['nxt-priority']) {
          if (headers['nxt-priority'] === 'low' || headers['nxt-priority'] === '0') {
            priority = 0
          } else if (headers['nxt-priority'] === 'normal' || headers['nxt-priority'] === '1') {
            priority = 1
          } else if (headers['nxt-priority'] === 'high' || headers['nxt-priority'] === '2') {
            priority = 2
          }
        }

        if (globalThis.__nxt_undici_global_headers) {
          Object.assign(headers, globalThis.__nxt_undici_global_headers)
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
            retry: opts.retry ?? 8,
            proxy: opts.proxy ?? false,
            cache: opts.cache ?? false,
            upgrade: opts.upgrade ?? false,
            follow: opts.follow ?? opts.redirect ?? 8,
            error: opts.error ?? opts.throwOnError ?? true,
            verify: opts.verify ?? false,
            logger: opts.logger ?? null,
            dns: opts.dns ?? true,
            connect: opts.connect,
            priority,
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

/**
 * @typedef {{
 *   origin: string?,
 *   path: string?,
 *   host: string?,
 *   hostname: string?,
 *   port: string|number?,
 *   protocol: string?,
 *   pathname: string?,
 *   search: string?,
 * }} URLObject
 * @typedef {string|URL|URLObject} URLLike
 */

/**
 * @typedef {{
 * }} LoggerLike
 */

/**
 * @typedef {{
 *   id: string | null | undefined,
 *   dispatch: function,
 *   dispatcher: import('@nxtedition/undici').Dispatcher | null | undefined,
 *   url: URLLike | null | undefined,
 *   origin: string?,
 *   path: string?,
 *   method: string | null | undefined,
 *   body: import('stream').Readable | Uint8Array | string | null | undefined,
 *   query: object | null | undefined,
 *   headers: Record<string, string> | null | undefined,
 *   signal: AbortSignal | null | undefined,
 *   reset: boolean | null | undefined,
 *   blocking: boolean | null | undefined,
 *   timeout: number | { headers?: number | null | undefined, body?: number | null | undefined } | null | undefined,
 *   headersTimeout: number | null | undefined,
 *   bodyTimeout: number | null | undefined,
 *   idempotent: boolean | null | undefined,
 *   retry: object | number | boolean | null | undefined,
 *   proxy: object | boolean | null | undefined,
 *   cache: object | boolean | null | undefined,
 *   upgrade: object | boolean | null | undefined,
 *   follow: object | boolean | null | undefined,
 *   error: object | boolean | null | undefined,
 *   verify: object | boolean | null | undefined,
 *   logger: LoggerLike | null | undefined,
 *   dns: object | boolean | null | undefined,
 *   connect: object | null | undefined,
 *   priority: 0 | 1 | 2 | "low" | "normal" | "high" | null | undefined,
 *   lookup: ((origin: string | URLLike | Array<string | URLLike> , opts: object, callback: (err: Error | null, address: string | null) => void) => void) | null | undefined,
 * }} RequestOptions
 */

/**
 *
 * @param {URLLike|RequestOptions} urlOrOpts
 * @param {RequestOptions|null} [opts]
 * @returns {Promise<{
 *  body: import('stream').Readable,
 *  statusCode: number,
 *  headers: Record<string, string | string[] | undefined>
 * }>}
 */
export function request(urlOrOpts, opts) {
  return _request(
    wrapDispatch(
      opts?.dispatch ??
        opts?.dispatcher ??
        globalThis.__nxt_undici_dispatcher ??
        undici.getGlobalDispatcher(),
    ),
    urlOrOpts,
    opts,
  )
}
