// Trace plumbing shared by the interceptors. The writer contract and the
// generic helpers live in @nxtedition/trace; only the nxt-undici-specific
// pieces (dispatch-opts url tagging, undici-flavored option validation) are
// implemented here.
//
// Importing @nxtedition/trace statically is safe despite the package cycle
// (@nxtedition/trace flushes through nxt-undici): the trace package imports
// nxt-undici lazily at first flush precisely so consumers can depend on it
// statically. The only constraint is publish order — @nxtedition/trace must
// be published before a nxt-undici release that depends on it.
//
// The contract in short: a writer is `{ write }` where `write` is the trace
// function while tracing is enabled and null while disabled (it flips between
// the two at runtime), so call sites gate on the resolved fn at zero cost when
// off. `write` must not call back into the request being traced — emission
// happens inside dispatch/handler control flow, and reentrancy there is
// unsupported.

import { validateTrace as validateTraceWriter } from '@nxtedition/trace'
import { InvalidArgumentError } from './errors.js'

// installTrace is part of the surface: the per-thread default writer lives in
// the Symbol.for('@nxtedition/app/trace') slot and is mirrored
// module-locally inside @nxtedition/trace, so a
// writer must be installed through installTrace — a bare slot assignment only
// propagates on the next mirror refresh.
export { traceWrite, traceSafe, traceErr, installTrace } from '@nxtedition/trace'

/**
 * @typedef {import('@nxtedition/trace').TraceWriter} TraceWriter
 */

/**
 * Validate an opts.trace value, rethrowing the package's plain Error as the
 * InvalidArgumentError (UND_ERR_INVALID_ARG) that dispatch option validation
 * is expected to throw. Returns the input unchanged.
 *
 * @param {unknown} trace
 * @returns {TraceWriter | null | undefined}
 */
export function validateTrace(trace) {
  try {
    return validateTraceWriter(trace)
  } catch {
    throw new InvalidArgumentError('invalid trace')
  }
}

/**
 * Bounded origin+path tag for trace docs. Mirrors log.js's sanitizeOrigin
 * userinfo guard: an origin string carrying `user:pass@host` credentials is
 * reduced to URL#origin (which never contains userinfo) before it can reach
 * the trace index; if such a string is not a parseable URL, prefer losing the
 * value over risking embedded credentials. Never throws — evaluated while
 * building docs inside handler control flow.
 *
 * @param {{ origin?: unknown, path?: unknown }} opts
 * @returns {string | null}
 */
export function traceUrl(opts) {
  try {
    const origin = opts.origin
    let str
    if (origin == null) {
      str = ''
    } else if (origin instanceof URL) {
      // Real URL instances already expose a credential-free origin.
      str = origin.origin
    } else {
      // Raw dispatch()/compose() callers may pass URL-like objects or arrays
      // (defaultLookup resolves those deeper in the chain) — stringify rather
      // than lose the doc.
      str = typeof origin === 'string' ? origin : String(origin)
      if (str.includes('@')) {
        try {
          str = new URL(str).origin
        } catch {
          str = '[redacted]'
        }
      }
    }
    const path = typeof opts.path === 'string' ? opts.path : ''
    return `${str}${path}`.slice(0, 256)
  } catch {
    return null
  }
}
