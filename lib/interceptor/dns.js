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
  const promises = new Map()

  // The `cache` Map is otherwise only ever written, never trimmed, so a process
  // touching many distinct hostnames over its lifetime would leak entries that
  // can never be selected again. Sweep dead entries (all records expired and
  // none in flight) at most once per SWEEP_INTERVAL to bound the O(n) cost.
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
  }

  function resolve(hostname, { ttl }) {
    let promise = promises.get(hostname)
    if (!promise) {
      promise = new Promise((resolve) => {
        dns.lookup(hostname, { all: true }, (err, records) => {
          promises.delete(hostname)

          if (err) {
            resolve([err, null])
          } else {
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
        const [err, val] = await resolve(hostname, { ttl })
        if (err) {
          throw err
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
        resolve(hostname, { ttl })
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
        // origin is rewritten to the resolved IP, so pin the host header to
        // the logical hostname — but never clobber an explicit user-supplied
        // host (virtual hosting). Lowercase lookup matches the pipeline
        // invariant (parseHeaders) and priority.js, which reads the same key.
        // Host is a singular header, so only a single non-empty string value
        // is preserved (same rule as priority.js) — an array (duplicate Host
        // field-lines) or an empty string falls back to the origin-derived
        // host.
        return dispatch(
          {
            ...opts,
            origin: url.origin,
            headers: {
              ...opts.headers,
              host: (typeof opts.headers?.host === 'string' && opts.headers.host) || host,
            },
          },
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
