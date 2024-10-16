import { DecoratorHandler } from '../utils.js'
import net from 'net'
import { resolve4 } from 'node:dns/promises'

let fastNow = Date.now()
setInterval(() => {
  fastNow = Date.now()
}, 500)

class Record {
  address = ''
  expires = 0
  errored = 0

  constructor({ address, ttl }) {
    this.address = address
    this.expires = fastNow + (ttl ?? 60) * 1e3
  }
}

class Handler extends DecoratorHandler {
  #handler
  #record

  constructor({ record }, { handler }) {
    super(handler)

    this.#handler = handler
    this.#record = record
  }

  onError(err) {
    if (
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'ENETDOWN',
        'ENETUNREACH',
        'EHOSTDOWN',
        'EHOSTUNREACH',
        'EHOSTNOTFOUND',
        'ENODATA',
        'EPIPE',
        'UND_ERR_CONNECT_TIMEOUT',
      ].includes(err.code) ||
      [503].includes(err.statusCode)
    ) {
      this.#record.errored = fastNow

      // TODO (fix): For how long do we "blacklist" the record?

      if (err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        // We don't expect this address to ever work again...
        this.#record.expires = Infinity
      }
    }

    return super.onError(err)
  }
}

export default (interceptorOpts) => (dispatch) => {
  /** @type {Map<string, Array<Record>>} */
  const dnsCache = new Map()

  return async (opts, handler) => {
    if (!opts.dns) {
      return dispatch(opts, handler)
    }

    const { protocol, port, hostname, host } = new URL(opts.origin)

    if (net.isIP(hostname) || opts.headers?.host || !port || !protocol) {
      return dispatch(opts, handler)
    }

    const now = Date.now()
    try {
      /** @type {Array|undefined} */
      let records = dnsCache.get(hostname)

      if (!records?.some((record) => record.expires > now && !record.errored)) {
        // TODO (fix): Re-use old records while fetching new ones or if fetching fails?
        // TODO (fix): Background refresh + health checks?
        // TODO (fix): What about old "blacklisted" records?
        // TODO (fix): What about ipv6?

        records = await resolve4(hostname, { ttl: true })
        records = records.map((record) => new Record(record))

        if (records.length > 0) {
          // TODO (fix): Clear old hostnames?
          dnsCache.set(hostname, records)
        }
      }

      if (records.length === 0) {
        return dispatch(opts, handler)
      }

      // TODO (perf): sort + Math.random is a bit naive...
      records.sort((a, b) =>
        a.errored !== b.errored ? a.errored - b.errored : Math.random() - 0.5,
      )

      const record = records.find((record) => record.expires > now)

      if (!record) {
        return dispatch(opts, handler)
      }

      return dispatch(
        {
          ...opts,
          origin: `${protocol}//${record.address}:${port}`,
          headers: { ...opts.headers, host },
        },
        new Handler({ record }, { handler }),
      )
    } catch (err) {
      handler.onError(err)
    }
  }
}
