import type { Readable } from 'node:stream'

export interface URLObject {
  origin?: string | null
  path?: string | null
  host?: string | null
  hostname?: string | null
  port?: string | number | null
  protocol?: string | null
  pathname?: string | null
  search?: string | null
}

export type URLLike = string | URL | URLObject

export interface Dispatcher {
  dispatch(opts: object, handler: DispatchHandler): void
}

export interface DispatchHandler {
  onConnect?(abort: (reason?: Error) => void): void
  onHeaders?(
    statusCode: number,
    headers: Record<string, string | string[]>,
    resume: () => void,
  ): boolean | void
  onData?(chunk: Buffer): boolean | void
  onComplete?(trailers?: Record<string, string | string[]>): void
  onError?(err: Error): void
  onUpgrade?(
    statusCode: number,
    headers: Record<string, string | string[]>,
    socket: import('node:net').Socket,
  ): void
}

export type DispatchFn = (opts: DispatchOptions, handler: DispatchHandler) => void | Promise<void>

export type Interceptor = (dispatch: DispatchFn) => DispatchFn

export interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike
  debug(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
}

export interface DispatchOptions {
  id?: string | null
  origin?: string | null
  path?: string | null
  method?: string | null
  body?:
    | Readable
    | Uint8Array
    | string
    | ((signal: AbortSignal) => Readable | Uint8Array | string | Iterable<unknown>)
    | null
  query?: Record<string, unknown> | null
  headers?: Record<string, string | string[] | null | undefined> | null
  signal?: AbortSignal | null
  reset?: boolean | null
  blocking?: boolean | null
  timeout?: number | { headers?: number | null; body?: number | null } | null
  headersTimeout?: number | null
  bodyTimeout?: number | null
  idempotent?: boolean | null
  typeOfService?: number | null
  retry?: RetryOptions | number | boolean | RetryFn | null
  proxy?: ProxyOptions | boolean | null
  cache?: CacheOptions | boolean | null
  upgrade?: boolean | null
  follow?: number | FollowFn | boolean | null
  error?: boolean | null
  verify?: VerifyOptions | boolean | null
  logger?: LoggerLike | null
  dns?: DnsOptions | boolean | null
  connect?: Record<string, unknown> | null
  priority?:
    | 0
    | 1
    | 2
    | 'low'
    | 'normal'
    | 'high'
    | 'lower'
    | 'lowest'
    | 'higher'
    | 'highest'
    | null
  lookup?: LookupFn | null
}

export interface RetryOptions {
  count?: number
  retry?: RetryFn
}

export type RetryFn = (
  err: Error,
  retryCount: number,
  opts: DispatchOptions,
  defaultRetryFn: () => Promise<boolean>,
) => boolean | Promise<boolean>

export type FollowFn = (location: string, count: number, opts: DispatchOptions) => boolean

export type LookupFn = (
  origin: string | URLLike | Array<string | URLLike>,
  opts: { signal?: AbortSignal },
  callback: (err: Error | null, address: string | null) => void,
) => void | Promise<string>

export interface ProxyOptions {
  httpVersion?: string
  socket?: import('node:net').Socket
  name?: string
  req?: import('node:http').IncomingMessage
}

export interface CacheOptions {
  store?: CacheStore
  maxEntrySize?: number
}

export interface VerifyOptions {
  hash?: boolean
  size?: boolean
}

export interface DnsOptions {
  ttl?: number
  balance?: 'hash'
}

export interface LogInterceptorOptions {
  bindings?: Record<string, unknown>
}

export interface CacheKey {
  origin: string
  method: string
  path: string
  headers?: Record<string, string | string[] | null | undefined>
}

export interface CacheValue {
  statusCode: number
  statusMessage: string
  headers?: Record<string, string | string[]>
  body: Uint8Array | null
  start: number
  end: number
  cacheControlDirectives?: Record<string, unknown>
  etag?: string
  vary?: Record<string, string | string[]>
  cachedAt: number
  staleAt: number
  deleteAt?: number
}

export interface CacheGetResult {
  statusCode: number
  statusMessage: string
  headers?: Record<string, string | string[]>
  body?: Buffer
  etag?: string
  cacheControlDirectives?: Record<string, unknown>
  vary?: Record<string, string | string[]>
  cachedAt: number
  staleAt: number
  deleteAt: number
}

export interface CacheStore {
  get(key: CacheKey): CacheGetResult | undefined
  set(
    key: CacheKey,
    value: CacheValue & { body: null | Buffer | Buffer[]; start: number; end: number },
  ): void
  purgeStale(): void
  close(): void
}

export interface RequestOptions extends DispatchOptions {
  url?: URLLike | null
  dispatch?: DispatchFn | null
  dispatcher?: Dispatcher | null
}

export interface ResponseData {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: Readable
}

export function request(
  urlOrOpts: URLLike | RequestOptions,
  opts?: RequestOptions | null,
): Promise<ResponseData>

export function dispatch(
  dispatcher: Dispatcher,
  opts: DispatchOptions,
  handler: DispatchHandler,
): void | Promise<void>

export function compose(
  dispatcherOrInterceptor: Dispatcher | DispatchFn | Interceptor,
  ...interceptors: (Interceptor | null | undefined)[]
): DispatchFn

export function parseHeaders(
  headers:
    | Record<string, string | string[] | null | undefined>
    | (Buffer | string | (Buffer | string)[])[],
  obj?: Record<string, string | string[]>,
): Record<string, string | string[]>

export const interceptors: {
  query: () => Interceptor
  requestBodyFactory: () => Interceptor
  responseError: () => Interceptor
  responseRetry: () => Interceptor
  responseVerify: () => Interceptor
  log: (opts?: LogInterceptorOptions) => Interceptor
  redirect: () => Interceptor
  proxy: () => Interceptor
  cache: () => Interceptor
  requestId: () => Interceptor
  dns: () => Interceptor
  lookup: () => Interceptor
  priority: () => Interceptor
}

export const cache: {
  SqliteCacheStore: typeof SqliteCacheStore
}

export class SqliteCacheStore implements CacheStore {
  constructor(opts?: { location?: string; db?: Record<string, unknown>; maxSize?: number })
  get(key: CacheKey): CacheGetResult | undefined
  set(
    key: CacheKey,
    value: CacheValue & { body: null | Buffer | Buffer[]; start: number; end: number },
  ): void
  purgeStale(): void
  close(): void
}

export { Client, Pool, Agent, getGlobalDispatcher, setGlobalDispatcher } from '@nxtedition/undici'
