import net from 'node:net'
import { resolve4 } from 'node:dns/promises'
import { getFastNow } from '../utils.js'

export default () => (dispatch) => {
  const cache = new Map()

  async function resolve(hostname) {
    const records = await resolve4(hostname, { ttl: true })
    return records.map(({ address, ttl }) => ({ address, expires: getFastNow() + 1e3 * ttl }))
  }

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

    let records = (await cache.get(hostname))?.filter(({ expires }) => expires > now)
    if (records == null || records.length === 0) {
      const promise = resolve(hostname)
      cache.set(hostname, promise)
      records = await promise
      cache.set(hostname, records)
    }

    if (records.length === 0) {
      throw Object.assign(new Error('No DNS records found for the specified hostname.'), {
        code: 'ENOTFOUND',
        hostname: origin.hostname,
      })
    }

    const addresses = records.map(({ address }) => address)
    origin.hostname = addresses[Math.floor(Math.random() * addresses.length)]

    return dispatch({ ...opts, origin, headers: { ...opts.headers, host } }, handler)
  }
}
