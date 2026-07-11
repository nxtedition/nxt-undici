import net from 'node:net'
import * as dns from 'node:dns'
import { buildURL, DecoratorHandler, parseHeaders } from '../utils.js'
import { traceWrite, traceSafe, traceErr, traceUrl } from '../trace.js'
import xxhash from 'xxhash-wasm'

let HASHER

class Handler extends DecoratorHandler {
  #callback
  #statusCode

  constructor(handler, callback) {
    super(handler)
    this.#callback = callback
  }

  onHeaders(statusCode, headers, resume) {
    this.#statusCode = statusCode
    return super.onHeaders(statusCode, headers, resume)
  }

  onUpgrade(statusCode, headers, socket) {
    // A successful upgrade (HTTP 101) is its own terminal branch — neither
    // onComplete nor onError follows it. Settle the gauge here too, otherwise
    // record.pending is incremented (before dispatch) but never decremented for
    // any upgraded request, which permanently skews load balancing and pins the
    // hostname against sweep() (it requires pending === 0). onHeaders is not
    // guaranteed to run before onUpgrade, so settle with the upgrade status;
    // 101 < 500, so this only decrements pending without bumping `errored`.
    this.#callback(null, statusCode)
    super.onUpgrade(statusCode, headers, socket)
  }

  onComplete(trailers) {
    this.#callback(null, this.#statusCode)
    super.onComplete(trailers)
  }

  onError(err) {
    this.#callback(err, this.#statusCode)
    super.onError(err)
  }
}

const SWEEP_INTERVAL = 30e3

function validateTTL(name, value) {
  if (typeof value !== 'number') {
    throw new TypeError(`opts.dns.${name} must be a number`)
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`opts.dns.${name} must be a finite number greater than or equal to 0`)
  }
}

// A cached (or in-flight-shared) lookup error must never be handed to more
// than one caller as-is: downstream decorateError call sites (response-retry,
// response-error) mutate the error they receive (err.req, err.res,
// err.statusCode), so a shared object would leak one request's decoration
// into another's. Give each caller a fresh Error carrying the identifying
// dns fields, with the original attached as `cause`.
function makeLookupError(err) {
  const wrapped = new Error(err.message, { cause: err })
  wrapped.code = err.code
  if (err.errno !== undefined) {
    wrapped.errno = err.errno
  }
  if (err.syscall !== undefined) {
    wrapped.syscall = err.syscall
  }
  if (err.hostname !== undefined) {
    wrapped.hostname = err.hostname
  }
  return wrapped
}

// Error codes that mean the IP itself is unreachable/bad, so the selected
// record should be invalidated immediately (expires = 0), forcing a re-resolve.
// Anything else surfaced on the response path — a headers/body timeout, a
// content-length mismatch, a generic application error — means the IP was
// reachable (a connection was established); invalidating it would thrash DNS
// for a healthy host, so those only bump the soft `errored` load score instead.
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

export default () => (dispatch) => {
  // DNS options are per request, including a custom resolver. Keep every
  // resolver's positive, negative and in-flight state isolated: service
  // discovery clients commonly use the same logical hostname with different
  // resolvers, and an answer (or failure) from one must never satisfy another.
  // WeakMap also lets short-lived resolver functions and their cache state be
  // collected together.
  const resolverStates = new WeakMap()
  const resolverStateRefs = new Set()
  const resolverStateFinalizer = new FinalizationRegistry((ref) => resolverStateRefs.delete(ref))
  let lastSweep = 0

  function getResolverState(lookup) {
    let state = resolverStates.get(lookup)
    if (state == null) {
      state = {
        cache: new Map(),
        negatives: new Map(),
        promises: new Map(),
      }
      resolverStates.set(lookup, state)
      const ref = new WeakRef(state)
      resolverStateRefs.add(ref)
      resolverStateFinalizer.register(state, ref, ref)
    }
    return state
  }

  // The `cache` Map is otherwise only ever written, never trimmed, so a process
  // touching many distinct hostnames over its lifetime would leak entries that
  // can never be selected again. Sweep dead entries (all records expired and
  // none in flight) at most once per SWEEP_INTERVAL to bound the O(n) cost.
  // Negative entries are swept on the same cadence (they are also deleted
  // eagerly on the next successful lookup / overwritten on the next failure,
  // so the sweep only matters for hostnames that are never touched again).
  function sweepState(now, state) {
    for (const [hostname, records] of state.cache) {
      if (records.every((x) => x.expires < now && x.pending === 0)) {
        state.cache.delete(hostname)
      }
    }
    for (const [hostname, negative] of state.negatives) {
      if (negative.expires < now) {
        state.negatives.delete(hostname)
      }
    }
  }

  function sweep(now) {
    if (now - lastSweep < SWEEP_INTERVAL) {
      return
    }
    lastSweep = now

    // Any request can clean every live resolver state, so a resolver that was
    // used once cannot pin expired hostnames forever. Weak references preserve
    // the WeakMap's lifetime semantics; dead refs are removed both here and by
    // the finalizer, keeping the iterable registry bounded.
    for (const ref of resolverStateRefs) {
      const state = ref.deref()
      if (state == null) {
        resolverStateRefs.delete(ref)
        resolverStateFinalizer.unregister(ref)
      } else {
        sweepState(now, state)
      }
    }
  }

  function resolve(hostname, { ttl, negativeTTL, lookup, state }) {
    const { cache, negatives, promises } = state
    let promise = promises.get(hostname)
    if (!promise) {
      // A synchronous lookup callback (custom resolvers answering from a local
      // cache) runs inside the Promise executor, BEFORE the `promises.set`
      // below — its cleanup delete would be a no-op and the settled promise
      // would be retained forever, turning every later resolve() for the
      // hostname (misses and pre-emptive refreshes alike) into a stale no-op.
      // Track settlement so an already-settled promise is never registered.
      let settled = false
      promise = new Promise((resolve) => {
        const onLookup = (err, records) => {
          // A resolver is required to invoke its callback once, but custom
          // implementations can accidentally callback and then throw (or
          // callback twice). Ignore every terminal signal after the first so
          // it cannot overwrite a successful cache entry with a later error.
          if (settled) {
            return
          }
          settled = true
          promises.delete(hostname)

          let val = null
          let shouldCacheNegative = true
          if (!err) {
            try {
              if (!Array.isArray(records)) {
                throw new TypeError('invalid DNS lookup result: expected an array of records')
              }
              if (records.length === 0) {
                throw Object.assign(new Error(`No DNS records found for ${hostname}`), {
                  code: 'ENOTFOUND',
                  syscall: 'getaddrinfo',
                  hostname,
                })
              }

              const now = Date.now()
              val = records.map((record) => {
                const address = record?.address
                if (typeof address !== 'string' || net.isIP(address) === 0) {
                  throw new TypeError('invalid DNS lookup result: expected IP address records')
                }
                return {
                  address,
                  expires: now + (ttl ?? 1e3),
                  pending: 0,
                  errored: 0,
                  counter: 0,
                }
              })
            } catch (cause) {
              // A custom resolver invokes this callback outside the Promise
              // executor when it resolves asynchronously. Contain malformed
              // results here so they become ordinary lookup failures instead
              // of uncaught exceptions, and do not cache unusable addresses.
              // Empty successful results intentionally become ENOTFOUND and
              // remain negative-cacheable; locally detected shape/type errors
              // may be fixed by the resolver on its next call and must not
              // poison that recovery for the full negative TTL.
              err = cause
              shouldCacheNegative = cause?.code === 'ENOTFOUND'
            }
          }

          if (err) {
            // Negative cache: remember the failure for a short while so a hot
            // caller of an unresolvable host fails fast instead of issuing a
            // lookup storm (response-retry retries ENOTFOUND/EAI_AGAIN up to
            // `retry` (default 8) times, so without this every logical
            // request produced ~9 lookups). EAI_AGAIN is transient by
            // definition, but the same small TTL applies — the window only
            // needs to absorb a retry burst, and a short TTL keeps recovery
            // fast either way.
            if (shouldCacheNegative) {
              if (negativeTTL === 0) {
                negatives.delete(hostname)
              } else {
                negatives.set(hostname, { err, expires: Date.now() + negativeTTL })
              }
            } else {
              negatives.delete(hostname)
            }
            resolve([err, null])
          } else {
            negatives.delete(hostname)
            if (ttl === 0) {
              cache.delete(hostname)
            } else {
              cache.set(hostname, val)
            }

            resolve([null, val])
          }
        }

        try {
          lookup(hostname, { all: true }, onLookup)
        } catch (err) {
          if (settled) {
            // The resolver already called back and callback-side processing
            // threw (for example records.map on malformed synchronous data).
            // Preserve resolve()'s [err, val] contract so refresh callers never
            // receive a bare rejection and request callers use the ordinary
            // lookup-failure path.
            resolve([err, null])
            return
          }
          // Let the normal callback path remove in-flight state and create the
          // short negative-cache entry. Allowing the Promise constructor to
          // turn this into a bare rejection would leave that rejected promise
          // registered below forever.
          onLookup(err)
        }
      })
      if (!settled) {
        promises.set(hostname, promise)
      }
    }
    return promise
  }

  return async (opts, handler) => {
    // Keep terminal delivery once-only across both synchronous throws and
    // rejected DispatchFn promises, including the DNS/IP bypass paths.
    const wrapped = new DecoratorHandler(handler)
    try {
      if (!opts.dns || !opts.origin) {
        return await dispatch(opts, wrapped)
      }

      const ttl = opts.dns.ttl ?? 2e3
      const negativeTTL = opts.dns.negativeTTL ?? 1e3
      validateTTL('ttl', ttl)
      validateTTL('negativeTTL', negativeTTL)
      const lookup = opts.dns.lookup ?? dns.lookup
      if (typeof lookup !== 'function') {
        throw new TypeError('opts.dns.lookup must be a function')
      }
      // Parse the authority exclusively from the configured origin. Treating
      // opts.path as a URL reference would let an origin-form path beginning
      // with `//` (or an absolute/backslash equivalent) replace the hostname,
      // scheme and port before DNS resolution. buildURL keeps the origin
      // authoritative while still giving hash balancing a normalized pathname.
      // The original opts.path is forwarded unchanged below.
      const url = new URL(opts.origin)
      const { pathname } = buildURL(url.origin, opts.path)
      const balance = opts.dns.balance

      const { host, hostname } = url

      if (net.isIP(hostname)) {
        return await dispatch(opts, wrapped)
      }

      const state = getResolverState(lookup)
      const { cache, negatives, promises } = state
      const now = Date.now()

      sweep(now)

      let records = cache.get(hostname)

      if (records == null || records.every((x) => x.expires < now)) {
        // A fresh negative entry means a lookup for this hostname failed less
        // than negativeTTL ago — fail fast instead of hitting the resolver
        // again. Fresh positive records (checked above) take precedence, so a
        // failed pre-emptive refresh never fails requests that can still be
        // served from cache.
        const negative = negatives.get(hostname)
        if (negative != null && negative.expires >= now) {
          // Cold path (fail-fast) — resolve the writer per emission, like
          // response-retry's traceRetry.
          const write = traceWrite(opts.trace)
          if (write !== null) {
            traceSafe(
              write,
              {
                id: opts.id ?? null,
                url: traceUrl(opts),
                source: 'negative',
                durationMs: 0,
                records: null,
                err: traceErr(negative.err),
              },
              'undici:dns',
            )
          }
          throw makeLookupError(negative.err)
        }

        // Cold path (cache miss) — this request synchronously awaits the
        // (possibly shared in-flight) resolution, so attribute the wait to it;
        // concurrent awaiters each emit their own doc. The url tag is taken
        // from the logical opts, before the origin is rewritten to the IP.
        const write = traceWrite(opts.trace)
        const started = write !== null ? performance.now() : 0
        const [err, val] = await resolve(hostname, { ttl, negativeTTL, lookup, state })
        if (write !== null) {
          traceSafe(
            write,
            {
              id: opts.id ?? null,
              url: traceUrl(opts),
              source: 'miss',
              durationMs: Math.round(performance.now() - started),
              records: err ? null : val.length,
              err: err ? traceErr(err) : null,
            },
            'undici:dns',
          )
        }
        if (err) {
          throw makeLookupError(err)
        }
        records = val
      }

      let record

      if (balance === 'hash') {
        HASHER ??= await xxhash()

        const hash = HASHER.h32(pathname)

        for (let i = 0; i < records.length; i++) {
          const idx = (hash + i) % records.length
          if (records[idx].expires >= now) {
            record = records[idx]
            break
          }
        }
      }

      if (record == null) {
        // toSorted — balance:'hash' relies on the cached array's index order.
        const sorted = records.toSorted(
          (a, b) => a.errored - b.errored || a.pending - b.pending || a.counter - b.counter,
        )

        for (let i = 0; i < sorted.length; i++) {
          if (sorted[i].expires >= now) {
            record = sorted[i]
            break
          }
        }
      }

      if (!record) {
        throw Object.assign(new Error(`No available DNS records found for ${hostname}`), {
          code: 'ENOTFOUND',
          data: { records },
        })
      }

      // Pre-emptive refresh when any record is past half its TTL — the
      // in-flight request still uses the already-selected `record`; the
      // refreshed records land in cache for the next request, smoothing
      // out DNS lookup latency. `resolve()` dedupes via `promises`.
      if (records.some((x) => x.expires < now + ttl / 2)) {
        // Only the request that actually initiates the refresh observes it
        // (checked against `promises` BEFORE resolve() registers the new
        // in-flight promise): concurrent requests in the half-TTL window join
        // the same deduped lookup and would otherwise emit one doc each, with
        // attach-relative durations — the doc denotes the background lookup
        // itself, not a per-request wait (nothing awaits a refresh).
        const write = traceWrite(opts.trace)
        const initiated = write !== null && !promises.has(hostname)
        const promise = resolve(hostname, { ttl, negativeTTL, lookup, state })
        if (initiated) {
          // Side-observe a copy of the chain: resolve() never rejects (it
          // settles with an [err, val] tuple) and .then returns a new promise,
          // so the shared in-flight promise's other consumers are unaffected.
          const started = performance.now()
          promise.then(([err, val]) => {
            traceSafe(
              write,
              {
                id: opts.id ?? null,
                url: traceUrl(opts),
                source: 'refresh',
                durationMs: Math.round(performance.now() - started),
                records: err ? null : val.length,
                err: err ? traceErr(err) : null,
              },
              'undici:dns',
            )
          })
        }
      }

      url.hostname = net.isIPv6(record.address) ? `[${record.address}]` : record.address

      record.counter++
      record.pending++

      // Guarded so it runs exactly once: on the normal Handler callback, or
      // if dispatch throws synchronously (otherwise record.pending would leak
      // and skew load balancing toward the wrongly-busy record).
      let settled = false
      const onSettle = (err, statusCode) => {
        if (settled) {
          return
        }
        settled = true
        record.pending--

        if (err != null && err.name !== 'AbortError') {
          if (err.code != null && CONNECTION_ERROR_CODES.has(err.code)) {
            // The IP is bad/unreachable — drop it from rotation immediately.
            record.expires = 0

            // Cold path (connection error) — opts is the dispatch closure's;
            // eviction stays allocation-free while tracing is off.
            const write = traceWrite(opts.trace)
            if (write !== null) {
              const evictedAt = Date.now()
              let siblings = 0
              for (const x of records) {
                if (x.expires >= evictedAt) {
                  siblings++
                }
              }
              traceSafe(
                write,
                {
                  hostname: hostname.slice(0, 256),
                  address: String(record.address).slice(0, 256),
                  err: traceErr(err),
                  siblings,
                },
                'undici:dns-evict',
              )
            }
          } else {
            // Reachable IP, request failed for an unrelated reason (timeout
            // mid-stream, size mismatch, ...) — penalize softly, don't evict.
            record.errored++
          }
        } else if (statusCode != null && statusCode >= 500) {
          record.errored++
        }
      }

      try {
        // origin is rewritten to the resolved IP, so pin the host header to
        // the logical hostname — but never clobber an explicit user-supplied
        // host (virtual hosting). Normalize here too because the exported DNS
        // interceptor can be composed standalone, before the default pipeline's
        // parseHeaders step; field names remain case-insensitive in that mode.
        // Host is a singular header, so only a single non-empty string value
        // is preserved (same rule as priority.js) — an array (duplicate Host
        // field-lines) or an empty string falls back to the origin-derived
        // host.
        // parseHeaders owns the normalization fast path. Internally branded
        // snapshots are reused in O(1), while standalone/untrusted inputs are
        // copied and normalized before we mutate the result below.
        const headers = parseHeaders(opts.headers)
        if (typeof headers.host !== 'string' || !headers.host) {
          headers.host = host
        }

        // DispatchFn permits a Promise return. Await it inside the guarded
        // try/catch so an asynchronous downstream failure settles the record
        // and reaches onError; request() ignores the dispatch return value.
        return await dispatch(
          {
            ...opts,
            origin: url.origin,
            headers,
          },
          new Handler(wrapped, onSettle),
        )
      } catch (err) {
        onSettle(err)
        throw err
      }
    } catch (err) {
      wrapped.onError(err)
    }
  }
}
