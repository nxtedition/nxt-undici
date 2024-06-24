import assert from 'node:assert'
import { DecoratorHandler } from '../utils.js'
import CacheableLookup from 'cacheable-lookup'

let DEFAULT_DNS

class Handler extends DecoratorHandler {
  #handler
  #store
  #key

  constructor({ store, key }, { handler }) {
    super(handler)

    this.#handler = handler
    this.#store = store
    this.#key = key
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
      this.#store.clear(this.#key)
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

    const { hostname } = new URL(opts.origin)

    const callback = (err, entries) => {
      if (err) {
        handler.onConnect(() => {})
        handler.onError(err)
      } else {
        const url = new URL(opts.origin)
        url.hostname = entries[Math.floor(entries.length * Math.random())].address
        dispatch(
          { ...opts, origin: url.origin },
          new Handler({ store: dns, key: hostname }, { handler }),
        )
      }
    }

    const thenable = dns.lookup(hostname, { all: true }, callback)
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
