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
        headers['user-agent'] ??= opts.userAgent ?? globalThis.userAgent

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
            headersTimeout: opts.timeout?.headers ?? opts.headersTimeout,
            bodyTimeout: opts.timeout?.body ?? opts.bodyTimeout,
            idempotent: opts.idempotent,
            retry: opts.retry ?? 4,
            proxy: opts.proxy ?? false,
            cache: opts.cache ?? false,
            upgrade: opts.upgrade ?? false,
            follow: opts.follow ?? opts.redirect ?? 8,
            error: opts.error ?? opts.throwOnError ?? true,
            verify: opts.verify ?? false,
            logger: opts.logger ?? null,
            dns: opts.dns ?? true,
            connect: opts.connect,
            lookup: opts.lookup ?? defaultLookup,
          },
          handler,
        )?.catch((err) => handler.onError(err))
      },
    )
    dispatcherCache.set(dispatcher, wrappedDispatcher)
  }
  return wrappedDispatcher
}

export function dispatch(dispatcher, opts, handler) {
  return wrapDispatch(dispatcher)(opts, handler)?.catch((err) => handler.onError(err))
}

export function request(url, opts) {
  return _request(
    wrapDispatch(opts?.dispatch ?? opts?.dispatcher ?? undici.getGlobalDispatcher()),
    url,
    opts,
  )
}
