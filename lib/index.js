import undici from 'undici'
import { parseHeaders } from './utils.js'

const dispatcherCache = new WeakMap()

export const interceptors = {
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

export { parseHeaders } from './utils.js'
export { Client, Pool, Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

function defaultLookup(origin, opts, callback) {
  callback(null, Array.isArray(origin) ? origin[Math.floor(Math.random() * origin.length)] : origin)
}

function wrapDispatcher(dispatcher) {
  let wrappedDispatcher = dispatcherCache.get(dispatcher)
  if (wrappedDispatcher == null) {
    wrappedDispatcher = dispatcher.compose(
      interceptors.responseError(),
      interceptors.requestBodyFactory(),
      interceptors.log(),
      interceptors.dns(),
      interceptors.lookup(),
      interceptors.requestId(),
      interceptors.responseRetry(),
      interceptors.responseVerify(),
      interceptors.redirect(),
      interceptors.cache(),
      interceptors.proxy(),
      (dispatch) => (opts, handler) => {
        const headers = parseHeaders(opts.headers)

        const userAgent = opts.userAgent ?? globalThis.userAgent
        if (userAgent && headers?.['user-agent'] !== userAgent) {
          headers['user-agent'] = userAgent
        }

        const url = opts.url ? new URL(opts.url) : null

        return dispatch(
          {
            id: opts.id,
            origin: opts.origin ?? url?.origin,
            path: opts.path ?? (url?.search ? `${url.pathname}${url.search}` : url?.pathname),
            method: opts.method ?? (opts.body ? 'POST' : 'GET'),
            body: opts.body,
            query: opts.query,
            headers,
            signal: opts.signal,
            reset: opts.reset ?? false,
            blocking: opts.blocking ?? false,
            headersTimeout: opts.headersTimeout,
            bodyTimeout: opts.bodyTimeout,
            idempotent: opts.idempotent,
            retry: opts.retry ?? 4,
            proxy: opts.proxy ?? false,
            cache: opts.cache ?? false,
            upgrade: opts.upgrade ?? false,
            follow: opts.follow ?? 8,
            error: opts.error ?? true,
            verify: opts.verify ?? true,
            logger: opts.logger ?? null,
            dns: opts.dns ?? true,
            connect: opts.connect,
            lookup: opts.lookup ?? defaultLookup,
            maxRedirections: 0, // TODO (fix): Ugly hack to disable undici redirections.
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
  return wrapDispatcher(dispatcher).dispatch(opts, handler)
}

// HACK
const _request = undici.Dispatcher.prototype.request

export async function request(url, opts) {
  // TODO (fix): More argument validation...

  if (typeof url === 'string') {
    opts = { url: new URL(url), ...opts }
  } else if (url instanceof URL) {
    opts = { url, ...opts }
  } else if (typeof url.origin === 'string' && typeof (url.path ?? url.pathname) === 'string') {
    opts = opts ? { ...url, ...opts } : url
  }

  if (opts == null && typeof url === 'object' && url != null) {
    opts = url
  }

  return _request.call(await wrapDispatcher(opts.dispatcher ?? undici.getGlobalDispatcher()), opts)
}
