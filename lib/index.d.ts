import type { Dispatcher } from 'undici-types'
import type { Logger } from 'pino'

export type Headers =
  | Record<string, string | string[] | null | undefined>
  | (Buffer | string | (Buffer | string)[])[]

export interface NxtUndiciRequestInit extends RequestInit {
  headers?: Headers
  throwOnError?: boolean
  logger?: Logger
}

export function request(options: NxtUndiciRequestInit): Promise<Dispatcher.ResponseData>
export function request(
  url: string | URL,
  options?: NxtUndiciRequestInit,
): Promise<Dispatcher.ResponseData>
