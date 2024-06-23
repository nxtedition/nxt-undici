import assert from 'node:assert'
import { DecoratorHandler } from '../utils.js'
import CacheableLookup from 'cacheable-lookup'

let DEFAULT_DNS

class Handler extends DecoratorHandler {
  #handler
  #opts

  constructor(opts, { handler }) {
    super(handler)

    this.#opts = opts
  }

  onError(err) {
    if (
      err.code &&
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'ENETDOWN',
        'ENETUNREACH',
        'EHOSTDOWN',
        'EHOSTUNREACH',
        'EPIPE',
      ].includes(err.code)
    ) {
      this.#opts.dns.clear(this.#opts.origin)
    }

    return this.#handler.onError(err)
  }
}

export default (dispatch) => (opts, handler) => {
  const dns = opts.dns ?? (DEFAULT_DNS ??= new CacheableLookup())

  if (!dns) {
    return
  }

  assert(typeof dns.lookup === 'function')
  assert(typeof dns.clear === 'function')

  const origin = new URL(opts.origin)
  dns.lookup(origin.hostname, (err, address) => {
    if (err) {
      handler.onError(err)
    } else {
      origin.hostname = address
      dispatch({ ...opts, origin }, new Handler(opts, { handler }))
    }
  })
}
