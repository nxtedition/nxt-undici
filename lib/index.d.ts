import type { Readable } from 'node:stream'
import type { Priority } from '@nxtedition/scheduler'

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

export interface BodyReadable extends Readable {
  text(): Promise<string>
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  blob(): Promise<Blob>
  dump(): Promise<void>
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

/** The @nxtedition/trace writer contract: `write` is the emit fn while tracing
 *  is enabled and null while disabled (it flips between the two at runtime).
 *  The per-thread fallback writer lives in the Symbol.for('@nxtedition/app/trace')
 *  slot and must be installed via the package's installTrace(). */
export type { TraceWriter } from '@nxtedition/trace'
import type { TraceWriter } from '@nxtedition/trace'

export type BodyFactoryResult =
  | Readable
  | Uint8Array
  | string
  | Iterable<unknown>
  | AsyncIterable<unknown>

/** Called with an options object (not a bare signal); the signal aborts when the
 *  request is destroyed before the factory resolves. May be async. */
export type BodyFactory = (opts: {
  signal: AbortSignal
}) => BodyFactoryResult | Promise<BodyFactoryResult>

export interface DispatchOptions {
  id?: string | null
  origin?: string | null
  path?: string | null
  method?: string | null
  body?: Readable | Uint8Array | string | BodyFactory | null
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
  dispatcher?: Dispatcher | null
  retry?: RetryOptions | number | boolean | RetryFn | null
  proxy?: ProxyOptions | boolean | null
  cache?: CacheOptions | boolean | null
  /** Protocol to upgrade to (e.g. 'websocket'). undici requires a string and the
   *  dispatch handler must implement onUpgrade — only meaningful with raw
   *  dispatch()/compose(); request() has no upgrade support (see RequestOptions). */
  upgrade?: string | null
  follow?: number | FollowFn | boolean | null
  /** Alias for `follow`; ignored when `follow` is also set. */
  redirect?: number | FollowFn | boolean | null
  error?: boolean | null
  verify?: VerifyOptions | boolean | null
  logger?: LoggerLike | null
  /** Per-request trace writer: undefined falls back to the per-thread writer
   *  installed via @nxtedition/trace's installTrace(), null disables tracing
   *  for this request. */
  trace?: TraceWriter | null
  dns?: DnsOptions | boolean | null
  connect?: Record<string, unknown> | null
  priority?: Priority | null
  lookup?: LookupFn | null
}

export interface RetryOptions {
  count?: number
  /** Cap on the exponential backoff between attempts, in milliseconds
   *  (default 60_000; clamped to the ~2^31−1 ms timer max). The first retry is
   *  always immediate; subsequent waits are 1s·2^(n−1) capped here, with
   *  50–100% jitter applied. Does not affect a server-provided retry-after
   *  (clamped to 60s separately). */
  maxDelay?: number
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
  /** Upper bound on an entry's freshness lifetime AND retention, in seconds
   *  (default 30 days). */
  maxEntryTTL?: number
  /** Opt-in RFC 9111 §4.2.2 heuristic freshness (10% of time since
   *  Last-Modified) for 200 responses without explicit expiration. */
  heuristic?: boolean
  /** Opt-in fallback freshness lifetime in seconds for 200 responses without
   *  any expiration information. */
  defaultTTL?: number
}

export interface VerifyOptions {
  hash?: boolean
  size?: boolean
}

export interface DnsOptions {
  ttl?: number
  /** How long (ms) a failed lookup is negative-cached; requests inside this
   *  window fail fast without hitting the resolver again (default 1000). */
  negativeTTL?: number
  balance?: 'hash'
  /** Custom resolver, `dns.lookup`-compatible (called with `{ all: true }`). */
  lookup?: (
    hostname: string,
    options: { all: boolean },
    callback: (err: Error | null, addresses: { address: string; family: number }[]) => void,
  ) => void
}

export interface LogInterceptorOptions {
  bindings?: Record<string, unknown>
}

export interface PressureInterceptorOptions {
  /** Sampling interval for the internal EWMA loop, in ms (default 200).
   *  Set to 0 to disable the internal timer and drive sampling yourself via
   *  `sample()` from a loop you already run. */
  sampleInterval?: number
  /** EWMA time-constant in ms — the smoothing/desensitizing window (default 10000). */
  tau?: number
  /** Schmitt-trigger dead-band for `some` (shed discretionary work). */
  someHi?: number
  someLo?: number
  /** Schmitt-trigger dead-band for `full` (pause the producer). */
  fullHi?: number
  fullLo?: number
  /** Schmitt-trigger dead-band for `errorRate` (mark the origin degraded). */
  errHi?: number
  errLo?: number
}

export interface PressureStats {
  /** Gauge: requests dispatched but not yet connected (waiting for a slot). */
  pending: number
  /** Gauge: requests connected and in-flight. */
  running: number
  /** Counter: cumulative settled requests (onComplete + onError). */
  completed: number
  /** Counter: cumulative settled requests that were overload errors (429/420/5xx, transport failures). */
  errored: number
  /** EWMA in [0,1]: fraction of recent time the origin had a connection backlog. */
  some: number
  /** EWMA in [0,1]: fraction of recent time the origin made zero progress under backlog. */
  full: number
  /** EWMA in [0,1]: smoothed fraction of completions that were overload errors. */
  errorRate: number
  /** Latched: shed discretionary work (engaged when `some` crosses `someHi`). */
  shed: boolean
  /** Latched: pause the producer (engaged when `full` crosses `fullHi`). */
  paused: boolean
  /** Latched: error rate too high (engaged when `errorRate` crosses `errHi`). */
  degraded: boolean
}

export interface PressureReading {
  some: number
  full: number
  errorRate: number
  shed: boolean
  paused: boolean
  degraded: boolean
}

export interface PressureInterceptor {
  (dispatch: DispatchFn): DispatchFn
  /** Per-origin snapshot, or — with no argument — an array over every tracked origin. */
  stats(origin: string): PressureStats | undefined
  stats(): Array<PressureStats & { origin: string }>
  /** Smoothed pressure for an origin (zeroed/false for an untracked origin). */
  pressure(origin: string): PressureReading
  /** `full` pauses everything; `some` sheds only discretionary (low-priority) work. */
  shouldBackoff(origin: string, priority?: Priority): boolean
  /** Manually tick the EWMA loop (for `sampleInterval: 0`). */
  sample(): void
  /** Stop the internal timer and drop all tracked origins. */
  close(): void
  [Symbol.dispose](): void
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
  /** Optional on set(): omitting it defaults to deleteAt (staleAt === deleteAt). */
  staleAt?: number
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
  /** RFC 9111 §4.4 invalidation — optional; the cache interceptor
   *  feature-detects it and skips invalidation when absent. */
  delete?(key: CacheKey): void
  gc(): void
  clear(): void
  close(): void
}

/** `upgrade` is omitted: request()'s internal handler has no onUpgrade, so any
 *  upgrade attempt rejects with InvalidArgumentError — use dispatch() instead. */
export interface RequestOptions extends Omit<DispatchOptions, 'upgrade'> {
  url?: URLLike | null
  dispatch?: DispatchFn | null
  dispatcher?: Dispatcher | null
  /** highWaterMark for the response body readable (non-negative number). */
  highWaterMark?: number | null
}

export interface ResponseData {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: BodyReadable
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
  pressure: (opts?: PressureInterceptorOptions) => PressureInterceptor
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
  /** RFC 9111 §4.4: invalidates every stored response for the key's URI. */
  delete(key: CacheKey): void
  gc(): void
  clear(): void
  close(): void
}

export { Client, Pool, Agent, getGlobalDispatcher, setGlobalDispatcher } from '@nxtedition/undici'
