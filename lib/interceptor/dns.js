import net from 'node:net'
import { resolve4 } from 'node:dns/promises'
import { DecoratorHandler, getFastNow } from '../utils.js'

function noop() {}

const MAX_TTL = 10e3

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

  function resolve(hostname) {
    let promise = promises.get(hostname)
    if (!promise) {
      promise = resolve4(hostname, { ttl: true })
        .then((records) => {
          const now = getFastNow()
          const ret = records.map(({ address, ttl }) => ({
            address,
            expires: now + Math.min(MAX_TTL, 1e3 * ttl),
            pending: 0,
            errored: 0,
            counter: 0,
          }))
          cache.set(hostname, ret)
          return ret
        })
        .finally(() => {
          promises.delete(hostname)
        })
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

    const { host, hostname } = origin

    const now = getFastNow()

    let records = cache.get(hostname)

    if (records == null || records.every((x) => x.expires < now)) {
      records = await resolve(hostname)
    } else if (records.some((x) => x.expires < now + 1e3)) {
      resolve(hostname).catch(noop)
    }

    records.sort((a, b) => a.errored - b.errored || a.pending - b.pending || a.counter - b.counter)

    const record = records.find((x) => x.expires >= now)

    if (!record) {
      throw Object.assign(new Error(`No available DNS records found for ${hostname}`), {
        code: 'ENOTFOUND',
      })
    }

    origin.hostname = record.address

    record.counter++
    record.pending++
    try {
      return dispatch(
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
    } catch (err) {
      record.pending--
      throw err
    }
  }
}
