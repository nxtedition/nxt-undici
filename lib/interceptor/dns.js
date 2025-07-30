import net from 'node:net'
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
            const val = records.map(({ address }) => ({
              address,
              expires: now + (ttl ?? 1e3),
              pending: 0,
              errored: 0,
              counter: 0,
            }))

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
    if (!opts || !opts.dns || !opts.origin) {
      return dispatch(opts, handler)
    }

    const ttl = opts.dns.ttl ?? 2e3
    const origin = new URL(opts.origin)

    if (net.isIP(origin.hostname)) {
      return dispatch(opts, handler)
    }

    try {
      const { host, hostname } = origin

      const now = getFastNow()

      let records = cache.get(hostname)

      if (records == null || records.every((x) => x.expires < now)) {
        const [err, val] = await resolve(hostname, { ttl })

        if (err) {
          throw err
        }

        records = val
      } else if (records.some((x) => x.expires < now + 1e3)) {
        resolve(hostname, { ttl })
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

          if (err != null && err.name !== 'AbortError') {
            record.expires = 0
          } else if (statusCode != null && statusCode >= 500) {
            record.errored++
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
