import assert from 'node:assert'
import { DecoratorHandler } from '../utils.js'
import CacheableLookup from 'cacheable-lookup'
import net from 'net'

const DEFAULT_RESOLVER = new CacheableLookup()

class Handler extends DecoratorHandler {
  #handler
  #resolver
  #key

  constructor({ resolver, key }, { handler }) {
    super(handler)

    this.#handler = handler
    this.#resolver = resolver
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
      this.#resolver.clear(this.#key)
    }

    return this.#handler.onError(err)
  }
}

export default (interceptorOpts) => (dispatch) => (opts, handler) => {
  const dns = opts.dns

  if (!dns) {
    return dispatch(opts, handler)
  }

  const {
    resolver = interceptorOpts?.resolver ?? DEFAULT_RESOLVER,
    family = interceptorOpts?.family,
    hints = interceptorOpts?.hints,
    order = interceptorOpts?.order ?? 'ipv4first',
    all = interceptorOpts?.all ?? true,
  } = dns

  assert(typeof resolver.lookup === 'function')

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
          resolver.clear ? new Handler({ resolver, key: hostname }, { handler }) : handler,
        )
      }
    }

    try {
      const thenable = resolver.lookup(hostname, { family, hints, order, all }, callback)
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
