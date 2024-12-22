import net from 'node:net'
import { resolve4 } from 'node:dns/promises'
import { getFastNow } from '../utils.js'

export default () => (dispatch) => {
  const active = new Map()
  const cache = new Map()

  async function _refresh(hostname, now) {
    const records = await resolve4(hostname, { ttl: true })
    const ret = records.map(({ address, ttl }) => ({ address, expires: now + 1e3 * ttl }))

    cache.set(hostname, ret)
    active.delete(hostname)

    return ret
  }

  async function refresh(hostname, now) {
    let promise = active.get(hostname)
    if (!promise) {
      promise = _refresh(hostname, now)
      active.set(hostname, promise)
    }
    return promise
  }

  async function resolve(hostname) {
    const now = getFastNow()

    let records = cache.get(hostname)?.filter(({ expires }) => expires > now)
    if (records == null || records.length === 0) {
      records = await refresh(hostname, now)
    }

    return records.map(({ address }) => address)
  }

  return async (opts, handler) => {
    if (!opts || !opts.dns || !opts.origin) {
      return dispatch(opts, handler)
    }

    const origin = new URL(opts.origin)

    if (net.isIP(origin.hostname)) {
      return dispatch(opts, handler)
    }

    const records = await resolve(origin.hostname)

    if (records.length === 0) {
      throw Object.assign(new Error('No DNS records found for the specified hostname.'), {
        code: 'ENOTFOUND',
        hostname: origin.hostname,
      })
    }

    const host = origin.host

    origin.hostname = records[Math.floor(Math.random() * records.length)]

    return dispatch({ ...opts, origin, headers: { ...opts.headers, host } }, handler)
  }
}
