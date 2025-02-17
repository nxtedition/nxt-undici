import net from 'node:net'
import createError from 'http-errors'
import { DecoratorHandler } from '../utils.js'

class Handler extends DecoratorHandler {
  #opts

  constructor(proxyOpts, { handler }) {
    super(handler)

    this.#opts = proxyOpts
  }

  onUpgrade(statusCode, headers, socket) {
    super.onUpgrade(
      statusCode,
      reduceHeaders(
        {
          headers,
          httpVersion: this.#opts.httpVersion ?? this.#opts.req?.httpVersion,
          socket: this.#opts.socket,
          proxyName: this.#opts.name,
        },
        (acc, key, val) => {
          acc[key] = val
          return acc
        },
        {},
      ),
      socket,
    )
  }

  onHeaders(statusCode, headers, resume) {
    return super.onHeaders(
      statusCode,
      reduceHeaders(
        {
          headers,
          httpVersion: this.#opts.httpVersion ?? this.#opts.req?.httpVersion,
          socket: this.#opts.socket,
          proxyName: this.#opts.name,
        },
        (acc, key, val) => {
          acc[key] = val
          return acc
        },
        {},
      ),
      resume,
    )
  }
}

// This expression matches hop-by-hop headers.
// These headers are meaningful only for a single transport-level connection,
// and must not be retransmitted by proxies or cached.
const HOP_EXPR =
  /^(te|host|upgrade|trailers|connection|keep-alive|http2-settings|transfer-encoding|proxy-connection|proxy-authenticate|proxy-authorization)$/i

// Removes hop-by-hop and pseudo headers.
// Updates via and forwarded headers.
// Only hop-by-hop headers may be set using the Connection general header.
function reduceHeaders({ headers, proxyName, httpVersion, socket }, fn, acc) {
  let via = ''
  let forwarded = ''
  let host = ''
  let authority = ''
  let connection = ''

  for (const [key, val] of Object.entries(headers)) {
    const len = key.length
    if (len === 3 && !via && key === 'via') {
      via = val
    } else if (len === 4 && !host && key === 'host') {
      host = val
    } else if (len === 9 && !forwarded && key === 'forwarded') {
      forwarded = val
    } else if (len === 10 && !connection && key === 'connection') {
      connection = val
    } else if (len === 10 && !authority && key === ':authority') {
      authority = val
    }
  }

  let remove = []
  if (connection && !HOP_EXPR.test(connection)) {
    remove = connection.split(/,\s*/)
  }

  for (const [key, val] of Object.entries(headers)) {
    if (key.charAt(0) !== ':' && !remove.includes(key) && !HOP_EXPR.test(key)) {
      acc = fn(acc, key, val.toString())
    }
  }

  if (socket) {
    const forwardedHost = authority || host
    acc = fn(
      acc,
      'forwarded',
      (forwarded ? forwarded + ', ' : '') +
        [
          socket.localAddress && `by=${printIp(socket.localAddress, socket.localPort)}`,
          socket.remoteAddress && `for=${printIp(socket.remoteAddress, socket.remotePort)}`,
          `proto=${socket.encrypted ? 'https' : 'http'}`,
          forwardedHost && `host="${forwardedHost}"`,
        ].join(';'),
    )
  } else if (forwarded) {
    // The forwarded header should not be included in response.
    throw new createError.BadGateway()
  }

  if (proxyName) {
    if (via) {
      if (via.split(',').some((name) => name.endsWith(proxyName))) {
        throw new createError.LoopDetected()
      }
      via += ', '
    } else {
      via = ''
    }
    via += `${httpVersion ?? 'HTTP/1.1'} ${proxyName}`
  }

  if (via) {
    acc = fn(acc, 'via', via)
  }

  return acc
}

function printIp(address, port) {
  const isIPv6 = net.isIPv6(address)
  let str = `${address}`
  if (isIPv6) {
    str = `[${str}]`
  }
  if (port) {
    str = `${str}:${port}`
  }
  if (isIPv6 || port) {
    str = `"${str}"`
  }
  return str
}

export default () => (dispatch) => (opts, handler) => {
  if (!opts.proxy) {
    return dispatch(opts, handler)
  }

  const expectsPayload =
    opts.method === 'PUT' ||
    opts.method === 'POST' ||
    opts.method === 'PATCH' ||
    opts.method === 'QUERY'

  const headers = reduceHeaders(
    {
      headers: opts.headers ?? {},
      httpVersion: opts.proxy.httpVersion ?? opts.proxy.req?.httpVersion,
      socket: opts.proxy.socket ?? opts.proxy.req?.socket,
      proxyName: opts.proxy.name,
    },
    (obj, key, val) => {
      if (key === 'content-length' && !expectsPayload) {
        // https://tools.ietf.org/html/rfc7230#section-3.3.2
        // A user agent SHOULD NOT send a Content-Length header field when
        // the request message does not contain a payload body and the method
        // semantics do not anticipate such a body.
        // undici will error if provided an unexpected content-length: 0 header.
      }
      if (key[0] === ':') {
        // strip pseudo headers
      } else if (key === 'expect') {
        // undici doesn't support expect header.
      } else {
        obj[key] = val
      }
      return obj
    },
    {},
  )

  return dispatch({ ...opts, headers }, new Handler(opts.proxy, { handler }))
}
