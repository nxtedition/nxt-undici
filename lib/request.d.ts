import type { Dispatch, HeadersObject, RequestBody, RequestOptions, RequestResult, URLLike } from './index.js'

export interface RequestHandlerInit {
  signal?: AbortSignal | EventTarget | { on?(event: string, listener: (...args: unknown[]) => void): unknown; addEventListener?(event: string, listener: (...args: unknown[]) => void): unknown } | null
  method?: string | null
  body?: RequestBody
  highWaterMark?: number | null
}

export class RequestHandler implements import('@nxtedition/undici').Dispatcher.DispatchHandlers {
  constructor(init: RequestHandlerInit, resolve: (result: RequestResult | PromiseLike<RequestResult>) => void)
  onConnect(abort: (reason?: unknown) => void): void
  onHeaders(statusCode: number, headers: HeadersObject, resume: () => void): boolean | void
  onData(chunk: Uint8Array): boolean | void
  onComplete(trailers?: HeadersObject): void
  onError(error: Error): void
}

export function request(
  dispatch: Dispatch,
  urlOrOpts: URLLike | RequestOptions,
  opts?: RequestOptions | null,
): Promise<RequestResult>
