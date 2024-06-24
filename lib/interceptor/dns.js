import assert from 'node:assert'
import { DecoratorHandler } from '../utils.js'
import CacheableLookup from 'cacheable-lookup'

let DEFAULT_DNS

class Handler extends DecoratorHandler {
  #handler
  #opts
  #hostname

  constructor(opts, hostname, { handler }) {
    super(handler)

    this.#handler = handler
    this.#opts = opts
    this.#hostname = hostname
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
      this.#opts.dns.clear(this.#hostname)
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
    const hostname = url.hostname

    const callback = (err, entries) => {
      if (err) {
        handler.onConnect(() => {})
        handler.onError(err)
      } else {
        url.hostname = entries[entries.length * Math.random()].address
        dispatch({ ...opts, origin: url.origin }, new Handler(opts, hostname, { handler }))
      }
    }

    const thenable = dns.lookup(new URL(opts.origin), { all: true }, callback)
    if (typeof thenable?.then === 'function') {
      thenable.then(
        (val) => callback(null, val),
        (err) => callback(err),
      )
    }
  } catch (err) {
    handler.onConnect(() => {})
    handler.onError(err)
  }
}
