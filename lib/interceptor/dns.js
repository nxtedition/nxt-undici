import assert from 'node:assert'
import { DecoratorHandler } from '../utils.js'
import CacheableLookup from 'cacheable-lookup'
import net from 'net'

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
        'ENODATA',
        'EPIPE',
      ].includes(err.code)
    ) {
      this.#store.clear(this.#key)
    }

    return this.#handler.onError(err)
  }
}

export default (interceptorOpts) => (dispatch) => (opts, handler) => {
  const dns = opts.dns

  if (!dns) {
    dispatch(opts, handler)
    return
  }

  const {
    store = interceptorOpts?.store ?? (DEFAULT_DNS ??= new CacheableLookup()),
    family = interceptorOpts?.family,
    hints = interceptorOpts?.hints,
    order = interceptorOpts?.order ?? 'ipv4first',
    all = interceptorOpts?.all ?? true,
  } = dns

  assert(typeof store.lookup === 'function')

  const { hostname } = new URL(opts.origin)

  if (net.isIP(hostname)) {
    dispatch(opts, handler)
  } else {
    const callback = (err, val) => {
      if (err) {
        handler.onConnect(() => {})
        handler.onError(err)
      } else {
        const url = new URL(opts.origin)
        url.hostname = Array.isArray(val)
          ? val[Math.floor(val.length * Math.random())].address
          : val?.address ?? val
        dispatch(
          { ...opts, origin: url.origin },
          store.clear ? new Handler({ store, key: hostname }, { handler }) : handler,
        )
      }
    }

    try {
      const thenable = store.lookup(hostname, { family, hints, order, all }, callback)
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
}
