import type {
  Agent,
  Client,
  Dispatcher,
  Pool,
  Readable as UndiciReadable,
} from '@nxtedition/undici'

type BlobLike = globalThis extends { Blob: infer B } ? B : never

export type HeadersObject = Record<string, string | string[] | undefined>
export type RequestQuery = Record<string, unknown> | URLSearchParams
export type NodeReadable = import('stream').Readable
export type RequestBodyPayload =
  | NodeReadable
  | AsyncIterable<Uint8Array>
  | Uint8Array
  | ArrayBufferView
  | string
  | Buffer
  | BlobLike
export type RequestBodyFactory = (ctx: { signal: AbortSignal }) =>
  | RequestBodyPayload
  | Promise<RequestBodyPayload>
export type RequestBody = RequestBodyPayload | RequestBodyFactory
export interface TimeoutOptions {
  headers?: number | null | undefined
  body?: number | null | undefined
}

export interface URLObject {
  origin?: string | null
  protocol?: string | null
  host?: string | null
  hostname?: string | null
  port?: string | number | null
  pathname?: string | null
  path?: string | null
  search?: string | null
}

export type URLLike = string | URL | URLObject

export interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike
  debug?(obj: unknown, msg?: string): void
  info?(obj: unknown, msg?: string): void
  warn?(obj: unknown, msg?: string): void
  error?(obj: unknown, msg?: string): void
}

export interface ProxyRequestLike {
  httpVersion?: string
  socket?: import('node:net').Socket | null
}

export interface ProxyOptions {
  name?: string
  socket?: import('node:net').Socket | null
  req?: ProxyRequestLike | null
  httpVersion?: string
}

export type RequestPriority =
  | number
  | 'highest'
  | 'higher'
  | 'high'
  | 'normal'
  | 'low'
  | 'lower'
  | 'lowest'

export interface RetryConfig {
  count?: number
}

export type RetryDecision = (
  err: Error,
  retryCount: number,
  opts: DispatchOptions,
  next: (err: Error | null, retryCount: number, opts: DispatchOptions) =>
    | boolean
    | Promise<boolean>,
) => boolean | Promise<boolean>

export type RetryOption = number | boolean | RetryConfig | RetryDecision | null | undefined

export interface CacheKey {
  origin: string
  path: string
  method: string
  headers?: HeadersObject
}

export interface CacheValue {
  body: Buffer | Buffer[] | null
  start: number
  end: number
  statusCode: number
  statusMessage: string
  headers?: HeadersObject
  cacheControlDirectives?: Record<string, unknown>
  etag?: string
  vary?: Record<string, string | string[]>
  cachedAt: number
  staleAt: number
  deleteAt: number
}

export interface CacheResult {
  body?: Buffer
  statusCode: number
  statusMessage: string
  headers?: HeadersObject
  cacheControlDirectives?: Record<string, unknown>
  etag?: string
  vary?: Record<string, unknown>
  cachedAt: number
  staleAt: number
  deleteAt: number
}

export interface CacheStore {
  get(key: CacheKey): CacheResult | undefined
  set(key: CacheKey, value: CacheValue): void
  close?(): void
  maxEntrySize?: number
  maxEntryTTL?: number
}

export interface CacheOptions {
  store?: CacheStore
  maxEntrySize?: number
  maxEntryTTL?: number
}

export type CacheSetting = boolean | CacheOptions

export interface FollowOptions {
  count?: number
}

export type FollowDecision = (location: string, attempt: number, opts: DispatchOptions) => boolean

export type FollowSetting = number | FollowOptions | FollowDecision | boolean

export interface VerifyOptions {
  hash?: boolean
  size?: boolean
}

export interface DnsOptions {
  ttl?: number
  balance?: 'hash' | string
}

export type DnsSetting = boolean | DnsOptions

export type LookupFunction = (
  origin: string | URLLike | Array<string | URLLike>,
  opts: { signal?: AbortSignal },
  callback: (err: Error | null, address: string | null) => void,
) => void | PromiseLike<string | URLLike | null | undefined>

export interface DispatchOptions {
  id?: string | null
  origin: string
  path: string
  method: string
  body?: RequestBody
  query?: RequestQuery | null
  headers: HeadersObject
  signal?: AbortSignal | null
  reset?: boolean
  blocking?: boolean
  timeout?: number | TimeoutOptions | null
  headersTimeout?: number | null
  bodyTimeout?: number | null
  idempotent?: boolean | null
  retry?: RetryOption
  proxy?: ProxyOptions | false
  cache?: CacheOptions | false
  upgrade?: boolean | null
  follow?: FollowSetting
  typeOfService?: number | null
  error?: boolean | Record<string, unknown> | null
  verify?: boolean | VerifyOptions | null
  logger?: LoggerLike | null
  dns?: DnsSetting
  connect?: import('@nxtedition/undici').Dispatcher.ConnectOptions | null
  priority?: RequestPriority | null
  lookup?: LookupFunction | null
  userAgent?: string | null
}

export interface RequestOptions {
  id?: string | null
  dispatch?: Dispatch | null
  dispatcher?: DispatcherLike | null
  url?: URLLike | null
  origin?: string | null
  path?: string | null
  method?: string | null
  body?: RequestBody
  query?: RequestQuery | null
  headers?: HeadersObject | null
  signal?: AbortSignal | null
  reset?: boolean | null
  blocking?: boolean | null
  timeout?: number | TimeoutOptions | null
  headersTimeout?: number | null
  bodyTimeout?: number | null
  idempotent?: boolean | null
  retry?: RetryOption
  proxy?: boolean | ProxyOptions | null
  cache?: CacheSetting | null
  upgrade?: boolean | null
  follow?: FollowSetting
  redirect?: FollowSetting
  typeOfService?: number | null
  error?: boolean | Record<string, unknown> | null
  throwOnError?: boolean | null
  verify?: boolean | VerifyOptions | null
  logger?: LoggerLike | null
  dns?: DnsSetting | null
  connect?: import('@nxtedition/undici').Dispatcher.ConnectOptions | null
  priority?: RequestPriority | null
  lookup?: LookupFunction | null
  userAgent?: string | null
}

export type DispatcherHandlers = Parameters<Dispatcher['dispatch']>[1]
export type DispatcherResult = ReturnType<Dispatcher['dispatch']>

export interface DispatcherLike {
  dispatch: Dispatcher['dispatch']
}

export type Dispatch = (opts: DispatchOptions, handler: DispatcherHandlers) => DispatcherResult

export interface RequestResult {
  body: UndiciReadable
  statusCode: number
  headers: HeadersObject
}

export type InterceptorFactory = (dispatch: Dispatch) => Dispatch

export interface LogInterceptorOptions {
  bindings?: Record<string, unknown>
}

export interface InterceptorsMap {
  query(): InterceptorFactory
  requestBodyFactory(): InterceptorFactory
  responseError(): InterceptorFactory
  responseRetry(): InterceptorFactory
  responseVerify(): InterceptorFactory
  log(options?: LogInterceptorOptions): InterceptorFactory
  redirect(): InterceptorFactory
  proxy(): InterceptorFactory
  cache(): InterceptorFactory
  requestId(): InterceptorFactory
  dns(): InterceptorFactory
  lookup(): InterceptorFactory
  priority(): InterceptorFactory
}

export const interceptors: InterceptorsMap

export const cache: {
  SqliteCacheStore: typeof import('./sqlite-cache-store.js').SqliteCacheStore
}

export function compose(
  first: DispatcherLike | Dispatch,
  ...rest: Array<InterceptorFactory | null | undefined>
): Dispatch

export function dispatch(
  dispatcher: DispatcherLike,
  opts: DispatchOptions,
  handler: DispatcherHandlers,
): DispatcherResult

export function request(urlOrOpts: URLLike | RequestOptions, opts?: RequestOptions | null): Promise<RequestResult>

export { parseHeaders } from './utils.js'
export { Client, Pool, Agent, getGlobalDispatcher, setGlobalDispatcher } from '@nxtedition/undici'
