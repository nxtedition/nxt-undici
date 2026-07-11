import type { TraceWriter } from '@nxtedition/trace'
import {
  installTrace,
  traceErr,
  traceSafe,
  traceUrl,
  traceWrite,
  validateTrace,
} from '../lib/trace.js'

const writer: TraceWriter = {
  write(obj, op) {
    void obj
    void op
  },
}

installTrace(writer)
installTrace(undefined)

const validated: TraceWriter | null | undefined = validateTrace(writer)
const write: TraceWriter['write'] = traceWrite(validated)
const url: string | null = traceUrl({ origin: new URL('https://example.test'), path: '/path' })
const tag: string = traceErr(new Error('boom'))

if (write) {
  traceSafe(write, { url, tag }, 'test')
}

// @ts-expect-error traceUrl requires an options object
traceUrl('https://example.test')
