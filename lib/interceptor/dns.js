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

  onComplete(trailers) {
    this.#callback(null, this.#statusCode)
    super.onComplete(trailers)
  }

  onError(err) {
    this.#callback(err, this.#statusCode)
    super.onError(err)
  }
}

export default () => (dispatch) => {
  const cache = new Map()
  const promises = new Map()

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

      return dispatch(
        { ...opts, origin: url.origin, headers: { ...opts.headers, host } },
        new Handler(handler, (err, statusCode) => {
          record.pending--

          if (err != null && err.name !== 'AbortError') {
            record.expires = 0
          } else if (statusCode != null && statusCode >= 500) {
            record.errored++
          }
        }),
      )
    } catch (err) {
      handler.onError(err)
    }
  }
}
