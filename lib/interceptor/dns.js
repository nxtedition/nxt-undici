import assert from 'node:assert'
import { DecoratorHandler } from '../utils.js'
import CacheableLookup from 'cacheable-lookup'

let DEFAULT_DNS

class Handler extends DecoratorHandler {
  #handler
  #opts

  constructor(opts, { handler }) {
    super(handler)

    this.#handler = handler
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
      const url = new URL(this.#opts.origin)
      this.#opts.dns.clear(url.origin)
    }

    return this.#handler.onError(err)
  }
}

export default (opts) => (dispatch) => (opts, handler) => {
  const dns = opts.dns ?? (DEFAULT_DNS ??= new CacheableLookup())

  if (!dns) {
    dispatch(opts, handler)
    return
  }

  try {
    assert(typeof dns.lookup === 'function')
    assert(typeof dns.clear === 'function')

    const url = new URL(opts.origin)
    dns.lookup(url.hostname, (err, address) => {
      if (err) {
        handler.onConnect(() => {})
        handler.onError(err)
      } else {
        url.hostname = address
        dispatch({ ...opts, origin: url.origin }, new Handler(opts, { handler }))
      }
    })
  } catch (err) {
    handler.onConnect(() => {})
    handler.onError(err)
  }
}
