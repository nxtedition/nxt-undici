// Structural implementation of the @nxtedition/trace writer contract.
//
// The canonical contract lives in @nxtedition/trace (nxtedition/lib
// packages/trace) — but that package depends on this one (its makeTrace
// flushes trace docs to Elasticsearch through nxt-undici), so depending on it
// from here would create a publish-order cycle. The contract is small and
// stable, so it is implemented structurally instead: any writer that
// shape-matches `{ write }` works, including the per-thread default that
// @nxtedition/app's traceMiddleware installs at globalThis.__nxt_lib_trace.

/**
 * The trace writer contract: `write` is the trace function while tracing is
 * enabled and null while disabled (it flips between the two at runtime), so
 * call sites gate on it at zero cost when off.
 *
 * Contract: `write` must not call back into the request being traced —
 * emission happens inside dispatch/handler control flow, and reentrancy there
 * is unsupported.
 *
 * @typedef {object} TraceWriter
 * @property {((obj: object, op: string) => void) | null} write
 */

/**
 * Resolve the effective trace write fn for an operation: an explicit option
 * wins (null = tracing disabled for this request); when the option is absent,
 * fall back to the per-thread writer installed at globalThis.__nxt_lib_trace
 * (by `@nxtedition/app`'s traceMiddleware). Resolved lazily per request — the
 * global may be installed after startup, and `write` flips between fn and
 * null at runtime.
 *
 * @param {TraceWriter | null | undefined} trace
 * @returns {((obj: object, op: string) => void) | null}
 */
export function traceWrite(trace) {
  const t = trace === undefined ? globalThis.__nxt_lib_trace : trace
  const w = t?.write
  // typeof guard rather than a bare nullish check: `write` is caller-mutable
  // at runtime, and a truthy non-function must resolve to "disabled" instead
  // of a deferred TypeError at the emission site.
  return typeof w === 'function' ? w : null
}

/**
 * Emit a trace doc from inside dispatch/handler control flow. Tracing is
 * auxiliary — a throwing writer must never fail a request, break the handler
 * contract, or crash the process. Surface the failure as a process warning
 * instead of rethrowing.
 *
 * @param {(obj: object, op: string) => void} w
 * @param {object} obj
 * @param {string} op
 * @returns {void}
 */
export function traceSafe(w, obj, op) {
  try {
    w(obj, op)
  } catch (err) {
    // traceErr (never throws) rather than String(err): a writer throwing a
    // non-stringifiable value must not escape the containment either.
    process.emitWarning(err instanceof Error ? err : new Error(traceErr(err)))
  }
}

/**
 * Short, bounded error tag for trace docs — prefer the error code so the
 * field maps to one low-cardinality keyword in the trace index.
 * AggregateError and Error arrays tag each member (comma-joined, still
 * bounded). Must never throw: it is evaluated while building docs inside
 * handler control flow, so a poisoned error value (throwing getter,
 * unstringifiable object, cyclic aggregate) must yield a fallback tag, not a
 * new throw path.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function traceErr(err) {
  try {
    if (Array.isArray(err)) {
      return err
        .map((e) => traceErr(e))
        .join(',')
        .slice(0, 64)
    }
    const e = /** @type {{ code?: unknown, message?: unknown, errors?: unknown } | null} */ (err)
    if (typeof e?.code === 'string' && e.code !== '') {
      return e.code.slice(0, 64)
    }
    // AggregateError (and anything else carrying an `errors` array): the
    // members are more specific than the generic top-level message.
    if (Array.isArray(e?.errors) && e.errors.length > 0) {
      return e.errors
        .map((x) => traceErr(x))
        .join(',')
        .slice(0, 64)
    }
    if (typeof e?.message === 'string' && e.message !== '') {
      return e.message.slice(0, 64)
    }
    return String(err).slice(0, 64)
  } catch {
    return 'unknown'
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
