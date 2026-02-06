import type { DispatchOptions, HeadersObject, RequestBodyPayload, URLLike } from './index.js'

export interface RangeHeader {
  start: number
  end: number | null
  size: number | null
}

export type CacheControlDirectives = Record<string, string | number | boolean | undefined>

export function getFastNow(): number
export function parseCacheControl(str?: string | null): CacheControlDirectives | null
export function isDisturbed(body: unknown): boolean
export function parseContentRange(range?: string): RangeHeader | null | undefined
export function parseRangeHeader(range?: string): RangeHeader | null | undefined
export function parseURL(url: URLLike): URL
export function parseOrigin(url: URLLike): URL

export class AbortError extends Error {
  constructor(message?: string)
  code: string
}

export function isStream(obj: unknown): obj is import('stream').Readable
export function isBlobLike(object: unknown): boolean
export function isBuffer(buffer: unknown): buffer is Uint8Array
export function bodyLength(body: RequestBodyPayload | null | undefined): number | null

export class DecoratorHandler implements import('@nxtedition/undici').Dispatcher.DispatchHandlers {
  constructor(handler: import('@nxtedition/undici').Dispatcher.DispatchHandlers)
  onConnect(abort: (reason?: unknown) => void): void
  onUpgrade(statusCode: number, headers: HeadersObject, socket: unknown): void
  onHeaders(statusCode: number, headers: HeadersObject, resume: () => void): boolean | void
  onData(data: Uint8Array): boolean | void
  onComplete(trailers?: HeadersObject): void
  onError(err: Error): void
}

export function parseHeaders(
  headers: HeadersObject | Array<Buffer | string | Array<Buffer | string>>,
  obj?: HeadersObject,
): HeadersObject

export function decorateError(
  err: Error | null | undefined,
  opts: Pick<DispatchOptions, 'path' | 'origin' | 'method' | 'headers'>,
  meta: {
    statusCode?: number | null
    headers: HeadersObject
    trailers?: HeadersObject
    body?: unknown
  },
): Error
