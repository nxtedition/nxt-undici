import type { TraceWriter } from '@nxtedition/trace/core'

export { installTrace, traceErr, traceSafe, traceWrite } from '@nxtedition/trace/core'

export function validateTrace(trace: unknown): TraceWriter | null | undefined

export function traceUrl(opts: { origin?: unknown; path?: unknown }): string | null
