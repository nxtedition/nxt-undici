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
            const val = records.map(({ address }) => ({
              address,
              expires: now + (ttl ?? 1e3),
              pending: 0,
              errored: 0,
              counter: 0,
              timeout: 0,
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
    const url = new URL(opts.path ?? '', opts.origin)
    const balance = opts.dns.balance

    if (net.isIP(url.hostname)) {
      return dispatch(opts, handler)
    }

    const { host, hostname } = url

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

    let record

    if (balance === 'hash') {
      HASHER ??= await xxhash()

      const hash = HASHER.h32(url.pathname)

      for (let i = 0; i < records.length; i++) {
        const idx = (hash + i) % records.length
        if (records[idx].expires >= now && records[idx].timeout < now) {
          record = records[idx]
          break
        }
      }
    }

    if (record == null) {
      records.sort(
        (a, b) => a.errored - b.errored || a.pending - b.pending || a.counter - b.counter,
      )

      for (let i = 0; i < records.length; i++) {
        if (records[i].expires >= now) {
          record = records[i]
          break
        }
      }
    }

    if (!record) {
      throw Object.assign(new Error(`No available DNS records found for ${hostname}`), {
        code: 'ENOTFOUND',
      })
    }

    url.hostname = record.address

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

        if (err != null || statusCode >= 500) {
          record.timeout = getFastNow() + 10e3
        }
      }),
    )
  }
}
