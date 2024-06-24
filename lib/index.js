import undici from '@nxtedition/undici'
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
}

export { parseHeaders } from './utils.js'

export async function request(url, opts) {
  // TODO (fix): More argument validation...

  if (typeof url === 'string') {
    url = new URL(url)
  } else if (url instanceof URL) {
    // Do nothing...
  } else if (typeof url.origin === 'string' && typeof (url.path ?? url.pathname) === 'string') {
    // Do nothing...
  }

  if (opts == null && typeof url === 'object' && url != null) {
    opts = url
  }

  if (url) {
    // Do nothing...
  } else if (typeof opts.url === 'string') {
    url = new URL(opts.url)
  } else if (url.url instanceof URL) {
    url = opts.url
  } else if (typeof opts.origin === 'string' && typeof (opts.path ?? opts.pathname) === 'string') {
    url = opts
  } else {
    throw new Error('missing url')
  }

  const method = opts.method ?? (opts.body ? 'POST' : 'GET')
  const headers = parseHeaders(opts.headers)

  const userAgent = opts.userAgent ?? globalThis.userAgent
  if (userAgent && headers?.['user-agent'] !== userAgent) {
    headers['user-agent'] = userAgent
  }

  const baseDispatcher = opts.dispatcher ?? undici.getGlobalDispatcher()

  let dispatcher = dispatcherCache.get(baseDispatcher)
  if (dispatcher == null) {
    dispatcher = baseDispatcher.compose(
      interceptors.responseError(),
      interceptors.requestBodyFactory(),
      interceptors.log(),
      interceptors.dns(),
      interceptors.requestId(),
      interceptors.responseRetry(),
      interceptors.responseVerify(),
      interceptors.redirect(),
      interceptors.cache(),
      interceptors.proxy(),
    )
    dispatcherCache.set(baseDispatcher, dispatcher)
  }

  return await undici.request(url, {
    id: opts.id,
    method,
    dispatcher,
    body: opts.body,
    query: opts.query,
    headers,
    signal: opts.signal,
    reset: opts.reset ?? false,
    blocking: opts.blocking ?? false,
    headersTimeout: opts.headersTimeout,
    bodyTimeout: opts.bodyTimeout,
    idempotent: opts.idempotent,
    retry: opts.retry ?? 8,
    proxy: opts.proxy ?? false,
    cache: opts.cache ?? false,
    upgrade: opts.upgrade ?? false,
    follow: opts.follow ?? 8,
    error: opts.error ?? true,
    verify: opts.verify ?? true,
    logger: opts.logger ?? null,
  })
}
