import net from 'node:net'
import createError from 'http-errors'
import { DecoratorHandler } from '../utils.js'

function noop() {}

// Accumulator used by reduceHeaders on the response path. Hoisted to module
// scope so it is allocated once rather than on every onHeaders/onUpgrade call.
/**
 * @param {Record<string, string>} acc
 * @param {string} key
 * @param {string} val
 * @returns {Record<string, string>}
 */
const copyHeader = (acc, key, val) => {
  acc[key] = val
  return acc
}

class Handler extends DecoratorHandler {
  #opts

  constructor(proxyOpts, { handler }) {
    super(handler)

    this.#opts = proxyOpts
  }

  onUpgrade(statusCode, headers, socket) {
    let reduced
    try {
      reduced = reduceHeaders(
        {
          headers,
          httpVersion: this.#opts.httpVersion ?? this.#opts.req?.httpVersion,
          // Response path: never synthesize a Forwarded header (it is
          // request-only, RFC 7239) — passing socket would leak the proxy's
          // own addresses downstream. isResponse still rejects an inbound one.
          isResponse: true,
          proxyName: this.#opts.name,
        },
        copyHeader,
        {},
      )
    } catch (err) {
      // reduceHeaders throws on protocol errors (inbound Forwarded on a
      // response → BadGateway, looping Via → LoopDetected). A throw must not
      // escape onUpgrade: undici's H1 upgrade path nulls the request's queue
      // slot before invoking onUpgrade and its catch only destroys the socket
      // — no onError ever reaches the handler chain, leaving the caller
      // waiting forever. Deliver the terminal error downstream ourselves
      // (super.onError is once-guarded) and destroy the socket so it is not
      // leaked; noop error listener since nothing downstream ever receives it.
      socket.on('error', noop).destroy(err)
      super.onError(err)
      return
    }
    super.onUpgrade(statusCode, reduced, socket)
  }

  onHeaders(statusCode, headers, resume) {
    return super.onHeaders(
      statusCode,
      reduceHeaders(
        {
          headers,
          httpVersion: this.#opts.httpVersion ?? this.#opts.req?.httpVersion,
          isResponse: true,
          proxyName: this.#opts.name,
        },
        copyHeader,
        {},
      ),
      resume,
    )
  }
}

// ASCII case-insensitive equality where `b` is a lowercase literal and the
// caller guarantees `a.length === b.length`. Allocation-free.
/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function eqiLower(a, b) {
  if (a === b) {
    return true
  }
  for (let i = 0; i < b.length; i++) {
    let c = a.charCodeAt(i)
    if (c >= 0x41 && c <= 0x5a) {
      c += 0x20 // upper -> lower
    }
    if (c !== b.charCodeAt(i)) {
      return false
    }
  }
  return true
}

// Matches hop-by-hop headers — meaningful only for a single transport-level
// connection, so a proxy must not retransmit or cache them. This is the single
// source of truth for that set: it is used both for the per-key strip below
// and for the Connection-value check. HTTP field names are ASCII tokens, so a
// length-dispatched ASCII case-insensitive compare is exactly equivalent to a
// `/^(te|host|…)$/i` regexp (verified over 137k generated keys) while staying
// allocation-free and letting the common (non-hop) header bail out in a single
// comparison.
/**
 * @param {string} key
 * @returns {boolean}
 */
function isHopByHop(key) {
  switch (key.length) {
    case 2:
      return eqiLower(key, 'te')
    case 4:
      return eqiLower(key, 'host')
    case 7:
      // `trailer` (RFC 7230 §4.4) is hop-by-hop and must not be relayed; it was
      // previously missed here (only `upgrade` shares this length), leaking the
      // upstream's Trailer announcement to the next hop after transfer-encoding
      // was already stripped.
      return eqiLower(key, 'upgrade') || eqiLower(key, 'trailer')
    case 8:
      // 'trailers' is the RFC 2616 §13.5.1 spelling kept for compatibility.
      return eqiLower(key, 'trailers')
    case 10:
      return eqiLower(key, 'connection') || eqiLower(key, 'keep-alive')
    case 14:
      return eqiLower(key, 'http2-settings')
    case 16:
      return eqiLower(key, 'proxy-connection')
    case 17:
      return eqiLower(key, 'transfer-encoding')
    case 18:
      return eqiLower(key, 'proxy-authenticate')
    case 19:
      return eqiLower(key, 'proxy-authorization')
    default:
      return false
  }
}

// Removes hop-by-hop and pseudo headers.
// Updates via and forwarded headers.
// Only hop-by-hop headers may be set using the Connection general header.
/**
 * @template T
 * @param {object} options
 * @param {Record<string, string | string[]>} options.headers Header map; a
 *   value is an array when the field appeared more than once.
 * @param {string} [options.proxyName] This proxy's name. When set, a Via
 *   segment is appended and Via loop detection runs.
 * @param {string} [options.httpVersion] Protocol token for the appended Via
 *   segment; defaults to `'HTTP/1.1'`.
 * @param {{ localAddress?: string, localPort?: number, remoteAddress?: string,
 *   remotePort?: number, encrypted?: boolean } | null} [options.socket] Request
 *   path only: when present a Forwarded header is synthesised. An inbound
 *   Forwarded header is always treated as a BadGateway (it is request-only).
 * @param {boolean} [options.isResponse] Response path marker. When set,
 *   Forwarded is never synthesised regardless of `socket` (it would leak the
 *   proxy's own addresses downstream); an inbound Forwarded is still rejected.
 * @param {(acc: T, key: string, value: string) => T} fn Accumulator invoked
 *   once per retained header.
 * @param {T} acc Initial accumulator value.
 * @returns {T}
 */
function reduceHeaders({ headers, proxyName, httpVersion, socket, isResponse }, fn, acc) {
  let via = ''
  let forwarded = ''
  let host = ''
  let authority = ''
  /** @type {string | string[]} */
  let connection = ''

  // Iterate via Object.keys (computed once and reused by both passes) rather
  // than Object.entries: the latter allocates an outer array plus one
  // 2-element array per header on every call, and this runs on the hot path of
  // every proxied request and response. Object.keys allocates a single flat
  // array we reuse, cutting per-call allocation by ~4-6x.
  const keys = Object.keys(headers)

  // Object keys are unique, so each special is seen at most once; a repeated
  // field-line instead surfaces as an array value (parseHeaders collects them).
  // RFC 9110 §5.3 only permits repeats for list-valued fields (ABNF `#`), where
  // the parts are semantically one comma-separated value — those we combine.
  // Singular fields with more than one value are a protocol error — those we
  // reject.
  //
  // Field names are case-insensitive (RFC 7230). The production path lowercases
  // keys (parseHeaders) before this runs, but the standalone interceptors.proxy()
  // composition may pass mixed-case keys, so capture case-insensitively via the
  // allocation-free eqiLower — otherwise a mixed-case `Forwarded`/`Connection`/
  // `Via`/`Host` would skip capture and leak/bypass the handling below.
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const len = key.length
    if (len === 3 && eqiLower(key, 'via')) {
      // Via is list-valued (RFC 9110 §7.6.3): combine repeated field-lines.
      const v = headers[key]
      via = Array.isArray(v) ? v.join(', ') : v
    } else if (len === 4 && eqiLower(key, 'host')) {
      // Host is singular (RFC 9110 §7.2, RFC 7230 §5.4): more than one is a
      // protocol error, so reject rather than combine.
      const v = headers[key]
      if (Array.isArray(v)) {
        throw new createError.BadGateway()
      }
      host = v
    } else if (len === 9 && eqiLower(key, 'forwarded')) {
      // Forwarded is list-valued (RFC 7239 §4): combine repeated field-lines.
      const v = headers[key]
      forwarded = Array.isArray(v) ? v.join(', ') : v
    } else if (len === 10 && eqiLower(key, 'connection')) {
      // Connection is list-valued (RFC 9110 §7.6.1): captured raw and tokenised
      // below — combining then re-splitting would be wasteful.
      connection = headers[key]
    } else if (len === 10 && key === ':authority') {
      // :authority is singular (RFC 9113 §8.3.1): reject more than one. Pseudo
      // headers are always lowercase, so an exact compare is correct here.
      const v = headers[key]
      if (Array.isArray(v)) {
        throw new createError.BadGateway()
      }
      authority = v
    }
  }

  // `remove` is lazily allocated: it stays null unless a Connection header
  // actually lists headers to strip (the uncommon case), so the hot path
  // neither allocates an (almost always empty) array nor runs includes() per
  // header.
  //
  // Header field names are case-insensitive (RFC 7230); parseHeaders already
  // lowercased the keys we compare against, so lowercase the listed names too,
  // otherwise `Connection: X-Custom` fails to strip `x-custom` and it leaks to
  // the next hop. trim() handles surrounding whitespace, so a plain comma split
  // suffices.
  let remove = null
  if (Array.isArray(connection)) {
    // Repeated Connection field-lines (RFC 9110 §7.6.1): each part may itself
    // list several options. A repeat always carries multiple/custom tokens, so
    // the single-hop-token shortcut below never applies.
    remove = []
    for (const part of connection) {
      for (const token of part.split(',')) {
        remove.push(token.trim().toLowerCase())
      }
    }
  } else if (connection && !isHopByHop(connection)) {
    // Single value: one field-line, so one split over its comma list. The
    // isHopByHop guard skips the common single-token forms (`keep-alive`,
    // `close`, …) where there is nothing custom to strip.
    remove = []
    for (const token of connection.split(',')) {
      remove.push(token.trim().toLowerCase())
    }
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const len = key.length
    if (
      key.charCodeAt(0) !== 0x3a /* ':' */ &&
      // via/forwarded are captured above and (re)emitted by the dedicated
      // finalization below; letting the retain loop also emit them leaks an
      // empty inbound value (e.g. `via: ''`) that the `if (via)` guard then
      // never overwrites, and bypasses the Forwarded BadGateway rejection.
      // Case-insensitive (eqiLower) to match the case-insensitive capture above.
      !(len === 3 && eqiLower(key, 'via')) &&
      !(len === 9 && eqiLower(key, 'forwarded')) &&
      // toLowerCase: `remove` entries are lowercased but keys may not be (the
      // standalone interceptor path), so match case-insensitively like isHopByHop.
      (remove === null || !remove.includes(key.toLowerCase())) &&
      !isHopByHop(key)
    ) {
      acc = fn(acc, key, headers[key].toString())
    }
  }

  if (!isResponse && socket) {
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
        ]
          .filter(Boolean)
          .join(';'),
    )
  } else if (forwarded) {
    // Forwarded is a request-only header (RFC 7239): a proxy must neither emit
    // it on a response nor relay one an upstream echoed back.
    throw new createError.BadGateway()
  }

  if (proxyName) {
    if (via) {
      const viaLower = via.toLowerCase()
      const proxyNameLower = proxyName.toLowerCase()
      // A Via segment is "received-protocol received-by [comment]". Compare the
      // received-by token for equality (case-insensitive) rather than testing
      // whether the whole segment ends with proxyName — endsWith() trips a
      // false-positive loop for any unrelated proxy whose name merely has
      // proxyName as a suffix (e.g. name 'proxy' vs upstream 'otherproxy').
      if (
        viaLower.includes(proxyNameLower) &&
        viaLower.split(',').some((seg) => {
          const by = seg.trim().split(/\s+/)[1]
          return by != null && by === proxyNameLower
        })
      ) {
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

/**
 * @param {string} address
 * @param {number} [port]
 * @returns {string}
 */
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
      } else if (key[0] === ':') {
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
