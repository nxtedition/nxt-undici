import net from 'node:net'
import * as dns from 'node:dns'
import { DecoratorHandler, getFastNow } from '../utils.js'
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
  const cache = new Map()
  const negatives = new Map()
  const promises = new Map()

  // The `cache` Map is otherwise only ever written, never trimmed, so a process
  // touching many distinct hostnames over its lifetime would leak entries that
  // can never be selected again. Sweep dead entries (all records expired and
  // none in flight) at most once per SWEEP_INTERVAL to bound the O(n) cost.
  // Negative entries are swept on the same cadence (they are also deleted
  // eagerly on the next successful lookup / overwritten on the next failure,
  // so the sweep only matters for hostnames that are never touched again).
  let lastSweep = 0
  function sweep(now) {
    if (now - lastSweep < SWEEP_INTERVAL) {
      return
    }
    lastSweep = now
    for (const [hostname, records] of cache) {
      if (records.every((x) => x.expires < now && x.pending === 0)) {
        cache.delete(hostname)
      }
    }
    for (const [hostname, negative] of negatives) {
      if (negative.expires < now) {
        negatives.delete(hostname)
      }
    }
  }

  function resolve(hostname, { ttl, negativeTTL, lookup }) {
    let promise = promises.get(hostname)
    if (!promise) {
      promise = new Promise((resolve) => {
        lookup(hostname, { all: true }, (err, records) => {
          promises.delete(hostname)

          if (err) {
            // Negative cache: remember the failure for a short while so a hot
            // caller of an unresolvable host fails fast instead of issuing a
            // lookup storm (response-retry retries ENOTFOUND/EAI_AGAIN up to
            // `retry` (default 8) times, so without this every logical
            // request produced ~9 lookups). EAI_AGAIN is transient by
            // definition, but the same small TTL applies — the window only
            // needs to absorb a retry burst, and a short TTL keeps recovery
            // fast either way.
            negatives.set(hostname, { err, expires: getFastNow() + negativeTTL })
            resolve([err, null])
          } else {
            negatives.delete(hostname)
            const now = getFastNow()
            const val = records.map(({ address }) => {
              return {
                address,
                expires: now + (ttl ?? 1e3),
                pending: 0,
                errored: 0,
                counter: 0,
              }
            })

            cache.set(hostname, val)

            resolve([null, val])
          }
        })
      })
      promises.set(hostname, promise)
    }
    return promise
  }

  return async (opts, handler) => {
    try {
      if (!opts.dns || !opts.origin) {
        return dispatch(opts, handler)
      }

      const ttl = opts.dns.ttl ?? 2e3
      const negativeTTL = opts.dns.negativeTTL ?? 1e3
      const lookup = opts.dns.lookup ?? dns.lookup
      const url = new URL(opts.path ?? '', opts.origin)
      const balance = opts.dns.balance

      const { host, hostname, pathname } = url

      if (net.isIP(hostname)) {
        return dispatch(opts, handler)
      }

      const now = getFastNow()

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
          throw makeLookupError(negative.err)
        }

        const [err, val] = await resolve(hostname, { ttl, negativeTTL, lookup })
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
        resolve(hostname, { ttl, negativeTTL, lookup })
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
        return dispatch(
          { ...opts, origin: url.origin, headers: { ...opts.headers, host } },
          new Handler(handler, onSettle),
        )
      } catch (err) {
        onSettle(err)
        throw err
      }
    } catch (err) {
      handler.onError(err)
    }
  }
}
