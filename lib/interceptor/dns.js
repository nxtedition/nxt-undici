import net from 'node:net'
import { resolve4 } from 'node:dns/promises'
import { DecoratorHandler, getFastNow } from '../utils.js'

function noop() {}

const MAX_TTL = 10e3

class Handler extends DecoratorHandler {
  #callback

  constructor(handler, callback) {
    super(handler)
    this.#callback = callback
  }

  onComplete(trailers) {
    this.#callback(null)
    super.onComplete(trailers)
  }

  onError(err) {
    this.#callback(err)
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
          const prev = cache.get(hostname)
          const next = records.map(({ address, ttl }) => ({
            address,
            expires: now + Math.min(MAX_TTL, 1e3 * ttl),
            stats: prev?.find((x) => x.address === address)?.stats || { pending: 0, errored: 0 },
          }))
          cache.set(hostname, next)
          return next
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

    if (records == null || records.every((x) => x.stats.errored || x.expires < now)) {
      records = await resolve(hostname)
    } else if (records.some((x) => x.errored || x.expires < now + 1e3)) {
      resolve(hostname).catch(noop)
    }

    records.sort((a, b) => {
      if (a.stats.errored !== b.stats.errored) {
        return a.stats.errored - b.stats.errored
      }

      if (a.stats.pending !== b.stats.pending) {
        return a.stats.pending - b.stats.pending
      }

      return 0
    })

    const record = records.find((x) => x.expires >= now)

    if (!record) {
      throw Object.assign(new Error(`No available DNS records found for ${hostname}`), {
        code: 'ENOTFOUND',
      })
    }

    origin.hostname = record.address

    record.stats.pending++
    try {
      return dispatch(
        { ...opts, origin, headers: { ...opts.headers, host } },
        new Handler(handler, (err) => {
          record.pending--
          if (err.name === 'AbortError') {
            // Do nothing...
          } else if (err.statusCode == null || err.statusCode >= 500) {
            record.stats.errored++
          } else {
            record.stats.errored = 0
          }
        }),
      )
    } catch (err) {
      record.stats.pending--
      throw err
    }
  }
}
