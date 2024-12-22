import net from 'node:net'
import { resolve4 } from 'node:dns/promises'

export default () => (dispatch) => {
  return async (opts, handler) => {
    if (!opts || !opts.dns || !opts.origin) {
      return dispatch(opts, handler)
    }

    const origin = new URL(opts.origin)

    if (net.isIP(origin.hostname)) {
      return dispatch(opts, handler)
    }

    const host = origin.host
    const records = await resolve4(origin.hostname)
    origin.hostname = records[Math.floor(Math.random() * records.length)]

    return dispatch({ ...opts, origin, headers: { ...opts.headers, host } }, handler)
  }
}
