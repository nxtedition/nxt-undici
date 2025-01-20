import net from 'node:net'
import { resolve4 } from 'node:dns/promises'
import { DecoratorHandler, getFastNow } from '../utils.js'

class Handler extends DecoratorHandler {
  #entry

  constructor(entry, handler) {
    super(handler)

    this.#entry = entry
    this.#entry.rif++
  }

  onConnect(...args) {
    super.onConnect(...args)
  }

  onHeaders(...args) {
    return super.onHeaders(...args)
  }

  onData(...args) {
    return super.onData(...args)
  }

  onComplete(...args) {
    this.#entry.rif--
    super.onComplete(...args)
  }

  onError(...args) {
    this.#entry.rif--
    super.onError(...args)
  }
}

export default () => (dispatch) => {
  const cache = new Map()
  const stats = new Map()

  return async (opts, handler) => {
    if (!opts || !opts.dns || !opts.origin) {
      return dispatch(opts, handler)
    }

    const origin = new URL(opts.origin)

    if (net.isIP(origin.hostname)) {
      return dispatch(opts, handler)
    }

    const now = getFastNow()
    const { host, hostname } = origin

    const promiseOrRecords = cache.get(hostname)

    let records = promiseOrRecords?.then ? await promiseOrRecords : promiseOrRecords

    records = records.filter(({ expires }) => expires > now)
    if (records == null || records.length === 0) {
      const promise = resolve4(hostname, { ttl: true }).then((records) =>
        records.map(({ address, ttl }) => ({ address, expires: now + 1e3 * ttl })),
      )
      cache.set(hostname, promise)
      records = await promise
      cache.set(hostname, records)
    }

    if (records == null || records.length === 0) {
      throw Object.assign(new Error('No DNS records found for the specified hostname.'), {
        code: 'ENOTFOUND',
        hostname: origin.hostname,
      })
    }

    const addresses = records.map(({ address }) => address)
    origin.hostname = addresses[Math.floor(Math.random() * addresses.length)]

    let entry = stats.get(origin.hostname)
    if (!entry) {
      entry = { rif: 0 }
      stats.set(hostname, entry)
    }

    return dispatch(
      { ...opts, origin, headers: { ...opts.headers, host } },
      new Handler(entry, handler),
    )
  }
}
