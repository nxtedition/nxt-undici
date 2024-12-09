import { DecoratorHandler } from '../utils.js'
import net from 'node:net'
import { resolve4 } from 'node:dns/promises'

let fastNow = Date.now()
setInterval(() => {
  fastNow = Date.now()
}, 500).unref()

async function isReachable({ port, host }, value) {
  return new Promise((resolve) => {
    const socket = new net.Socket()

    const onError = (err) => {
      // TODO (fix): Propagate error somewhere/somehow?
      socket.destroy(err)
      resolve(null)
    }

    socket.setTimeout(1e3)
    socket.once('error', onError)
    socket.once('timeout', onError)

    socket.connect(port, host, () => {
      socket.end()
      resolve(value)
    })
  })
}

class Record {
  address = ''
  expires = 0
  errored = 0
  running = 0
  failing = 0

  constructor({ address, ttl }) {
    this.address = address
    this.expires = fastNow + (ttl ?? 60) * 1e3
  }
}

class Handler extends DecoratorHandler {
  #record

  constructor({ record, handler }) {
    super(handler)
    this.#record = record
    this.#record.running += 1
  }

  onComplete(...args) {
    this.#record.running -= 1

    return super.onComplete(...args)
  }

  onError(err) {
    this.#record.running -= 1

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
      this.#record.expires = fastNow + 10e3
    }

    return super.onError(err)
  }
}

export default () => (dispatch) => {
  const dnsState = new Map()

  async function refresh({ host, hostname, port }) {
    let records
    try {
      // TODO (fix): ipv6?
      records = net.isIP(hostname)
        ? [{ address: hostname, ttl: 10 }]
        : await resolve4(hostname, { ttl: true })
    } catch {
      // XXX
      records = [{ address: hostname, ttl: 10, errored: fastNow }]
    }

    // XXX: Is reachable shouldn't block other lookups?
    records = await Promise.all(
      records.map((record) => isReachable({ host: record.address, port }, record)),
    )
    records = records.filter(Boolean).map((record) => new Record(record))

    dnsState.set(host, records)

    return records
  }

  function get(origin) {
    const records = dnsState.get(origin.host)
    if (records) {
      return records
    }

    const promise = refresh(origin)
    dnsState.set(origin.host, promise)
    return promise
  }

  async function resolve(origin) {
    const records = await get(origin)
    records.sort((a, b) => a.running - b.running)
    // XXX
    return (
      records.find((record) => record.expires > fastNow && !record.errored) ??
      records.find((record) => !record.errored) ??
      records.at(0)
    )
  }

  const weakDnsState = new WeakRef(dnsState)
  {
    const dnsRefreshInterval = setInterval(() => {
      const dnsState = weakDnsState.deref()
      if (dnsState == null) {
        clearInterval(dnsRefreshInterval)
      } else {
        // XXX: How often to refresh?
        // XXX: If not used for a while, stop refreshing?
        for (const host of dnsState.keys()) {
          refresh(new URL(host))
        }
      }
    }, 1e3).unref()
  }

  return async (opts, handler) => {
    if (!opts.dns) {
      return dispatch(opts, handler)
    }

    const origin = new URL(opts.origin)
    const record = await resolve(origin)

    return record
      ? dispatch(
          {
            ...opts,
            origin: `${origin.protocol}//${record.address}:${origin.port}`,
            headers: { ...opts.headers, host: origin.host },
          },
          new Handler({ record, handler }),
        )
      : dispatch(opts, handler)
  }
}
