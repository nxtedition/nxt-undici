import net from 'node:net'
import assert from 'node:assert'
import * as dns from 'node:dns'
import { DecoratorHandler, getFastNow } from '../utils.js'

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
    if (err?.statusCode == null) {
      this.#callback(err)
    } else if (err.statusCode) {
      this.#callback(null, err.statusCode)
    }
    super.onError(err)
  }
}

export default () => (dispatch) => {
  const cache = new Map()
  const promises = new Map()

  function resolve(resolve4, hostname) {
    let promise = promises.get(hostname)
    if (!promise) {
      promise = new Promise((resolve) =>
        resolve4(hostname, { ttl: true }, (err, records) => {
          if (err) {
            resolve([err, null])
          } else {
            const now = getFastNow()
            const val = records.map(({ address, ttl }) => ({
              address,
              expires: now + 1e3 * ttl,
              pending: 0,
              errored: 0,
              counter: 0,
            }))

            cache.set(hostname, val)

            resolve([null, val])
          }

          assert(promises.delete(hostname))
        }),
      )
      promises.set(hostname, promise)
    }
    return promise
  }

  return async (opts, handler) => {
    if (!opts || !opts.dns || !opts.origin) {
      return dispatch(opts, handler)
    }

    const origin = new URL(opts.origin)

    if (net.isIP(origin.hostname)) {
      return dispatch(opts, handler)
    }

    try {
      const { host, hostname } = origin

      const now = getFastNow()

      let records = cache.get(hostname)

      const resolve4 = opts.dns.resolve4 || dns.resolve4

      if (records == null || records.every((x) => x.expires < now)) {
        const [err, val] = await resolve(resolve4, hostname)

        if (err) {
          throw err
        }

        assert(val.every((x) => x.expires > 0))

        records = val
      } else if (records.some((x) => x.expires < now + 1e3)) {
        resolve(resolve4, hostname)
      }

      records.sort(
        (a, b) => a.errored - b.errored || a.pending - b.pending || a.counter - b.counter,
      )

      const record = records.find((x) => x.expires >= now)

      if (!record) {
        throw Object.assign(new Error(`No available DNS records found for ${hostname}`), {
          code: 'ENOTFOUND',
        })
      }

      origin.hostname = record.address

      dispatch(
        { ...opts, origin, headers: { ...opts.headers, host } },
        new Handler(handler, (err, statusCode) => {
          record.pending--

          if (statusCode != null && statusCode >= 500) {
            record.errored++
          } else if (err != null && err.name !== 'AbortError') {
            record.expires = 0
          }
        }),
      )

      record.counter++
      record.pending++
    } catch (err) {
      handler.onError(err)
    }
  }
}
