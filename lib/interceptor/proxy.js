import net from 'node:net'
import { domainToASCII } from 'node:url'
import createError from 'http-errors'
import { DecoratorHandler, parseHeaders } from '../utils.js'

const ORIGIN_FORM_PATH = /^\/(?![/\\\t\r\n])/
const ABSOLUTE_FORM_TARGET = /^https?:\/\//i
const kRequestTarget = Symbol('proxy request target')

function noop() {}

function unsupportedRequestTarget() {
  return new createError.BadRequest('Unsupported request target')
}

function isOriginFormPath(path) {
  return typeof path === 'string' && ORIGIN_FORM_PATH.test(path)
}

function assertOriginFormPath(path) {
  if (!isOriginFormPath(path)) {
    throw unsupportedRequestTarget()
  }
}

/**
 * Normalize an inbound proxy request target once, before cache, redirect and
 * logging observe the request. The configured origin remains authoritative:
 * absolute-form targets contribute only their already-parsed path and query.
 *
 * @param {unknown} path
 * @param {boolean | Record<string, unknown>} proxy
 * @returns {{ path: string, proxy: boolean | Record<string, unknown> }}
 */
export function normalizeProxyTarget(path, proxy) {
  if (!proxy || typeof proxy !== 'object' || !Object.hasOwn(proxy, 'requestTarget')) {
    return { path, proxy }
  }

  let normalizedPath = path

  if (!isOriginFormPath(normalizedPath)) {
    const requestTarget = proxy.requestTarget
    const pathname = requestTarget?.pathname
    const search = requestTarget?.search

    if (
      typeof path !== 'string' ||
      !ABSOLUTE_FORM_TARGET.test(path) ||
      !isOriginFormPath(pathname) ||
      (search != null && typeof search !== 'string')
    ) {
      throw unsupportedRequestTarget()
    }

    normalizedPath = `${pathname}${search ?? ''}`
  }

  proxy = { ...proxy }
  delete proxy.requestTarget

  return { path: normalizedPath, proxy }
}

function setOwnHeader(headers, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(headers, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  } else {
    headers[key] = value
  }
}

// Accumulator used by reduceHeaders on the response path. Hoisted to module
// scope so it is allocated once rather than on every onHeaders/onUpgrade call.
/**
 * @param {Record<string, string | string[]>} acc
 * @param {string} key
 * @param {string | string[]} val
 * @returns {Record<string, string | string[]>}
 */
const copyHeader = (acc, key, val) => {
  setOwnHeader(acc, key, val)
  return acc
}

class Handler extends DecoratorHandler {
  #opts
  #responseConnectionOptions = { value: null }

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
    // onHeaders may run for an informational response before the final one.
    // Only the final field section's Connection options apply to its trailers.
    this.#responseConnectionOptions.value = null

    return super.onHeaders(
      statusCode,
      reduceHeaders(
        {
          connectionOptions: this.#responseConnectionOptions,
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

  onComplete(trailers) {
    if (trailers == null) {
      return super.onComplete(trailers)
    }

    return super.onComplete(
      reduceHeaders(
        {
          connectionOptions: this.#responseConnectionOptions,
          headers: trailers,
          isResponse: true,
          isTrailer: true,
        },
        copyHeader,
        {},
      ),
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

// Via is a comma list, but each member may end in a nested HTTP comment whose
// ctext can itself contain commas and quoted-pair escapes (RFC 9110 §7.6.3,
// §5.6.5). Only top-level commas delimit members for loop checks.
function viaSegmentHasReceivedBy(via, start, end, proxyName) {
  let i = start
  while (i < end && (via.charCodeAt(i) === 0x20 || via.charCodeAt(i) === 0x09)) {
    i++
  }
  while (i < end && via.charCodeAt(i) !== 0x20 && via.charCodeAt(i) !== 0x09) {
    i++
  }
  while (i < end && (via.charCodeAt(i) === 0x20 || via.charCodeAt(i) === 0x09)) {
    i++
  }

  const receivedByStart = i
  while (
    i < end &&
    via.charCodeAt(i) !== 0x20 &&
    via.charCodeAt(i) !== 0x09 &&
    via.charCodeAt(i) !== 0x28 /* '(' */
  ) {
    i++
  }
  return i > receivedByStart && via.slice(receivedByStart, i) === proxyName
}

function validateViaComments(via) {
  let commentDepth = 0
  let escaped = false

  for (let i = 0; i < via.length; i++) {
    const char = via.charCodeAt(i)
    if (commentDepth !== 0) {
      if (escaped) {
        escaped = false
      } else if (char === 0x5c /* '\\' */) {
        escaped = true
      } else if (char === 0x28 /* '(' */) {
        commentDepth++
      } else if (char === 0x29 /* ')' */) {
        commentDepth--
      }
    } else if (char === 0x28 /* '(' */) {
      commentDepth = 1
    }
  }

  // Appending our member to an unterminated comment would place it inside that
  // comment. A later traversal would then miss our received-by forever and the
  // loop guard could be bypassed. A quoted-pair can leave the comment open by
  // ending with a pending escape or by escaping its would-be closing parenthesis.
  if (commentDepth !== 0) {
    throw new createError.BadGateway()
  }
}

function viaHasReceivedBy(via, proxyName) {
  let start = 0
  let commentDepth = 0
  let escaped = false

  for (let i = 0; i < via.length; i++) {
    const char = via.charCodeAt(i)
    if (commentDepth !== 0) {
      if (escaped) {
        escaped = false
      } else if (char === 0x5c /* '\\' */) {
        escaped = true
      } else if (char === 0x28 /* '(' */) {
        commentDepth++
      } else if (char === 0x29 /* ')' */) {
        commentDepth--
      }
    } else if (char === 0x28 /* '(' */) {
      commentDepth = 1
    } else if (char === 0x2c /* ',' */) {
      if (viaSegmentHasReceivedBy(via, start, i, proxyName)) {
        return true
      }
      start = i + 1
    }
  }

  return viaSegmentHasReceivedBy(via, start, via.length, proxyName)
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
 * Exported for reuse by the cache interceptor: RFC 9111 §3.1 forbids storing
 * hop-by-hop fields, which is the same set a proxy must not retransmit.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isHopByHop(key) {
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
    case 25:
      // RFC 9110 §11.7.3: like its Proxy-Auth* siblings this is scoped to the
      // client↔proxy connection and must not be retransmitted or cached.
      return eqiLower(key, 'proxy-authentication-info')
    default:
      return false
  }
}

function isOwsOnly(value) {
  if (typeof value !== 'string') {
    return false
  }

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code !== 0x20 && code !== 0x09) {
      return false
    }
  }
  return true
}

function joinNonEmptyHeaderValues(value) {
  if (!Array.isArray(value)) {
    return isOwsOnly(value) ? '' : value
  }

  let joined = ''
  for (const part of value) {
    if (!isOwsOnly(part)) {
      joined = joined ? `${joined}, ${part}` : part
    }
  }
  return joined
}

function validateForwardedQuotedStrings(value) {
  let quoted = false
  let escaped = false

  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i)
    if (escaped) {
      escaped = false
    } else if (quoted && char === 0x5c /* '\\' */) {
      escaped = true
    } else if (char === 0x22 /* '"' */) {
      quoted = !quoted
    }
  }

  // An open quoted-string hides the comma and trusted Forwarded element that
  // this proxy is about to append. A quoted-pair left pending at EOF is one
  // way the quoted-string can remain open.
  if (quoted) {
    throw new createError.BadGateway()
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeScheme(value) {
  return typeof value === 'string' && /^[a-z][a-z\d+.-]*$/i.test(value) ? value.toLowerCase() : null
}

/**
 * Normalize an HTTP authority for comparison. A neutral URL scheme keeps an
 * explicit port intact so the request's actual scheme can decide whether that
 * port is the default. Invalid authorities fail closed instead of falling back
 * to a raw string comparison.
 *
 * @param {unknown} value
 * @param {unknown} scheme
 * @returns {string | null}
 */
function normalizeAuthority(value, scheme) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('@')) {
    return null
  }

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) {
      return null
    }
  }

  let normalizedScheme = ''
  if (scheme != null) {
    normalizedScheme = normalizeScheme(scheme)
    if (normalizedScheme == null) {
      return null
    }
  }

  const url = URL.parse(`nxt-authority://${value}`)
  if (
    url == null ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null
  }

  // WHATWG URL keeps IPv6 literals bracketed. Preserve that unambiguous form
  // directly; domainToASCII is for registered names (and IPv4 spellings), not
  // IP-literal canonicalization.
  const hostname =
    url.hostname[0] === '[' ? url.hostname.toLowerCase() : domainToASCII(url.hostname)
  if (hostname === '') {
    return null
  }

  let port = url.port
  if (
    (normalizedScheme === 'http' && port === '80') ||
    (normalizedScheme === 'https' && port === '443')
  ) {
    port = ''
  }

  return port ? `${hostname}:${port}` : hostname
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
 *   path only: when present, a Forwarded element is synthesized and appended
 *   after any non-empty inbound value. Without a socket, a non-empty inbound
 *   Forwarded value is treated as a BadGateway.
 * @param {boolean} [options.isResponse] Response path marker. When set,
 *   Forwarded is never synthesized regardless of `socket` (it would leak the
 *   proxy's own addresses downstream), and a non-empty inbound value is
 *   rejected. Empty Forwarded values are dropped on either path.
 * @param {boolean} [options.isTrailer] Trailer field-section marker. Trailer
 *   fields are filtered without synthesizing Via/Forwarded or treating their
 *   presence as a late response error.
 * @param {{ value: string[] | null }} [options.connectionOptions] Mutable
 *   holder used by the response path to carry field names nominated by the
 *   response's Connection header into its trailer field section.
 * @param {(acc: T, key: string, value: string | string[]) => T} fn Accumulator
 *   invoked once per retained header. The value is an array when the field
 *   appeared more than once (parseHeaders shape) — never pre-joined, because
 *   fields like set-cookie (RFC 6265) must keep distinct field lines.
 * @param {T} acc Initial accumulator value.
 * @returns {T}
 */
function reduceHeaders(
  { headers, proxyName, httpVersion, socket, isResponse, isTrailer, connectionOptions },
  fn,
  acc,
) {
  let via = ''
  let viaSeen = false
  let forwarded = ''
  let forwardedSeen = false
  let host = ''
  let hostSeen = false
  let authority = ''
  let scheme
  /** @type {string | string[]} */
  let connection = ''
  let connectionSeen = false

  // Iterate via Object.keys (computed once and reused by both passes) rather
  // than Object.entries: the latter allocates an outer array plus one
  // 2-element array per header on every call, and this runs on the hot path of
  // every proxied request and response. Object.keys allocates a single flat
  // array we reuse, cutting per-call allocation by ~4-6x.
  const keys = Object.keys(headers)

  // A repeated field-line normally surfaces as an array value (parseHeaders
  // collects them). Standalone interceptor composition can additionally
  // receive case-variant object keys (`Via` plus `via`), which are the same
  // field because names are case-insensitive. RFC 9110 §5.3 only permits
  // repeats for list-valued fields (ABNF `#`), where the parts are semantically
  // one comma-separated value — those we combine. Singular fields with more
  // than one value are a protocol error — those we reject.
  //
  // Field names are case-insensitive (RFC 7230). The production path lowercases
  // keys (parseHeaders) before this runs, but the standalone interceptors.proxy()
  // composition may pass mixed-case keys, so capture case-insensitively via the
  // allocation-free eqiLower — otherwise a mixed-case `Forwarded`/`Connection`/
  // `Via`/`Host` would skip capture and leak/bypass the handling below.
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const len = key.length
    if (isTrailer && !(len === 10 && eqiLower(key, 'connection'))) {
      // Trailer blocks cannot change request routing and are delivered only
      // after the body. Do not validate singular routing fields or parse Via /
      // Forwarded here: all of those fields are discarded by the retain pass.
      continue
    }

    if (len === 3 && eqiLower(key, 'via')) {
      // Via is list-valued (RFC 9110 §7.6.3): combine repeated field-lines.
      const v = headers[key]
      const value = joinNonEmptyHeaderValues(v)
      if (value) {
        via = viaSeen ? `${via}, ${value}` : value
        viaSeen = true
      }
    } else if (len === 4 && eqiLower(key, 'host')) {
      // Host is singular (RFC 9110 §7.2, RFC 7230 §5.4): more than one is a
      // protocol error, so reject rather than combine. HeaderInput also allows
      // callers to express zero or one field value as [] / [value].
      let v = headers[key]
      if (Array.isArray(v)) {
        if (v.length > 1) {
          throw new createError.BadGateway()
        }
        if (v.length === 0) {
          continue
        }
        v = v[0]
      }
      if (hostSeen) {
        throw new createError.BadGateway()
      }
      host = v
      hostSeen = true
    } else if (len === 9 && eqiLower(key, 'forwarded')) {
      // Forwarded is list-valued (RFC 7239 §4): combine repeated field-lines.
      const v = headers[key]
      const value = joinNonEmptyHeaderValues(v)
      if (value) {
        forwarded = forwardedSeen ? `${forwarded}, ${value}` : value
        forwardedSeen = true
      }
    } else if (len === 10 && eqiLower(key, 'connection')) {
      // Connection is list-valued (RFC 9110 §7.6.1): captured raw and tokenised
      // below. Preserve every case-variant key just like parseHeaders preserves
      // repeated field-lines; otherwise a later `connection` key can overwrite
      // an earlier `Connection: x-secret` and let x-secret leak to the next hop.
      const v = headers[key]
      if (connectionSeen) {
        connection = [
          ...(Array.isArray(connection) ? connection : [connection]),
          ...(Array.isArray(v) ? v : [v]),
        ]
      } else {
        connection = v
        connectionSeen = true
      }
    } else if (len === 7 && key === ':scheme') {
      // :scheme is singular (RFC 9113 §8.3.1). HeaderInput represents zero
      // or one value as [] / [value], matching Host and :authority above.
      let v = headers[key]
      if (Array.isArray(v)) {
        if (v.length > 1) {
          throw new createError.BadGateway()
        }
        if (v.length === 0) {
          continue
        }
        v = v[0]
      }
      scheme = v
    } else if (len === 10 && key === ':authority') {
      // :authority is singular (RFC 9113 §8.3.1): reject more than one. Pseudo
      // headers are always lowercase, so an exact compare is correct here.
      // As with Host, [] means absent and [value] is one field value.
      let v = headers[key]
      if (Array.isArray(v)) {
        if (v.length > 1) {
          throw new createError.BadGateway()
        }
        if (v.length === 0) {
          continue
        }
        v = v[0]
      }
      authority = v
    }
  }

  if (!isResponse && scheme != null) {
    scheme = normalizeScheme(scheme)
    if (scheme == null) {
      throw new createError.BadGateway()
    }
  }

  const authorityValue = headers[':authority']
  const hasAuthority =
    Object.hasOwn(headers, ':authority') &&
    (!Array.isArray(authorityValue) || authorityValue.length !== 0)
  if (!isResponse && hostSeen && hasAuthority) {
    // RFC 9113 §8.3.1 forbids Host and :authority from identifying different
    // entities. Compare normalized authorities so harmless spelling differences
    // (host casing, a scheme's explicit default port) remain valid, while an
    // invalid authority cannot bypass the check by appearing identically in both.
    const requestScheme = scheme ?? (socket ? (socket.encrypted ? 'https' : 'http') : undefined)
    const normalizedHost = normalizeAuthority(host, requestScheme)
    const normalizedAuthority = normalizeAuthority(authority, requestScheme)
    if (normalizedHost == null || normalizedHost !== normalizedAuthority) {
      throw new createError.BadGateway()
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
  let remove = connectionOptions?.value ?? null
  if (Array.isArray(connection)) {
    // Repeated Connection field-lines (RFC 9110 §7.6.1): each part may itself
    // list several options. A repeat always carries multiple/custom tokens, so
    // the single-hop-token shortcut below never applies.
    remove ??= []
    for (const part of connection) {
      for (const token of part.split(',')) {
        remove.push(token.trim().toLowerCase())
      }
    }
  } else if (connection && !isHopByHop(connection)) {
    // Single value: one field-line, so one split over its comma list. The
    // isHopByHop guard skips the common single-token forms (`keep-alive`,
    // `close`, …) where there is nothing custom to strip.
    remove ??= []
    for (const token of connection.split(',')) {
      remove.push(token.trim().toLowerCase())
    }
  }

  if (connectionOptions) {
    connectionOptions.value = remove
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
      // A repeated field-line arrives as an array (parseHeaders collects
      // them). Pass it through as-is — .toString() would comma-join with no
      // space, corrupting fields whose values legally contain commas and must
      // never be combined: set-cookie (RFC 9110 §5.3 / RFC 6265, e.g. an
      // Expires date) and multi-challenge www-authenticate. Array values are
      // exactly the shape parseHeaders delivers without this interceptor, and
      // both the request path (undici accepts array header values) and the
      // response handler chain already relay it.
      const value = headers[key]
      acc = fn(acc, key, Array.isArray(value) ? value : value.toString())
    }
  }

  if (isTrailer) {
    // Via and Forwarded were deliberately excluded by the retain loop. They
    // are meaningful only in the initial field section: never append a Via
    // segment to trailers, and never turn an echoed Forwarded trailer into a
    // protocol error after the response body has already been delivered.
    return acc
  }

  if (!isResponse && socket) {
    if (forwarded) {
      validateForwardedQuotedStrings(forwarded)
    }

    const forwardedHost = authority || host
    acc = fn(
      acc,
      'forwarded',
      (forwarded && !remove?.includes('forwarded') ? forwarded + ', ' : '') +
        [
          socket.localAddress && `by=${printIp(socket.localAddress, socket.localPort)}`,
          socket.remoteAddress && `for=${printIp(socket.remoteAddress, socket.remotePort)}`,
          `proto=${scheme ?? (socket.encrypted ? 'https' : 'http')}`,
          forwardedHost && `host=${quoteForwardedString(forwardedHost)}`,
        ]
          .filter(Boolean)
          .join(';'),
    )
  } else if (forwarded && !remove?.includes('forwarded')) {
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
      // Always validate comment structure before appending our member. Keep the
      // includes() guard for received-by matching so the common non-looping path
      // avoids the segment parser and its slices.
      validateViaComments(viaLower)
      if (viaLower.includes(proxyNameLower) && viaHasReceivedBy(viaLower, proxyNameLower)) {
        throw new createError.LoopDetected()
      }
      via = remove?.includes('via') ? '' : via + ', '
    } else {
      via = ''
    }
    via += `${httpVersion ?? 'HTTP/1.1'} ${proxyName}`
  } else if (remove?.includes('via')) {
    via = ''
  }

  if (via) {
    acc = fn(acc, 'via', via)
  }

  return acc
}

/**
 * Forwarded's host parameter is a quoted-string because authorities commonly
 * contain `:`. Escape quoted-pair characters so an untrusted Host value cannot
 * close the string and inject a forged `for`, `by`, or `proto` parameter.
 *
 * @param {string} value
 * @returns {string}
 */
function quoteForwardedString(value) {
  return `"${value.replace(/["\\]/g, '\\$&')}"`
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

export const proxyTarget = () => (dispatch) => (opts, handler) => {
  if (
    !opts.proxy ||
    typeof opts.proxy !== 'object' ||
    !Object.hasOwn(opts.proxy, 'requestTarget')
  ) {
    return dispatch(opts, handler)
  }

  return dispatch(
    {
      ...opts,
      ...normalizeProxyTarget(opts.path, opts.proxy),
      [kRequestTarget]: true,
    },
    handler,
  )
}

export const proxyRequest = () => (dispatch) => (opts, handler) => {
  if (!opts.proxy) {
    return dispatch(opts, handler)
  }

  // Redirects and retries can mutate opts after the one-shot target
  // normalization. Reassert origin-form at every transport attempt so an
  // absolute or ambiguous path cannot be reintroduced below cache/log policy.
  if (opts[kRequestTarget]) {
    assertOriginFormPath(opts.path)
  }

  const expectsPayload =
    opts.method === 'PUT' ||
    opts.method === 'POST' ||
    opts.method === 'PATCH' ||
    opts.method === 'QUERY'

  const headers = reduceHeaders(
    {
      // The interceptor is public and can be composed without request(), so
      // opts.headers may still be any HeaderInput shape (including a raw flat
      // array or nullish object values). parseHeaders owns normalization and
      // is an O(1) identity operation for the package's trusted snapshots.
      headers: parseHeaders(opts.headers),
      httpVersion: opts.proxy.httpVersion ?? opts.proxy.req?.httpVersion,
      socket: opts.proxy.socket ?? opts.proxy.req?.socket,
      proxyName: opts.proxy.name,
    },
    (obj, key, val) => {
      // Case-insensitive (eqiLower) like reduceHeaders' capture above: the
      // standalone interceptors.proxy() composition may pass mixed-case keys
      // (the production path lowercases via parseHeaders first).
      if (!expectsPayload && key.length === 14 && eqiLower(key, 'content-length')) {
        // https://tools.ietf.org/html/rfc7230#section-3.3.2
        // A user agent SHOULD NOT send a Content-Length header field when
        // the request message does not contain a payload body and the method
        // semantics do not anticipate such a body.
        // undici will error if provided an unexpected content-length: 0 header.
      } else if (key[0] === ':') {
        // strip pseudo headers
      } else if (key.length === 6 && eqiLower(key, 'expect')) {
        // undici doesn't support expect header.
      } else {
        setOwnHeader(obj, key, val)
      }
      return obj
    },
    {},
  )

  const dispatchOpts = { ...opts, headers }
  delete dispatchOpts[kRequestTarget]
  return dispatch(dispatchOpts, handler)
}

export const proxyResponse = () => (dispatch) => (opts, handler) => {
  if (!opts.proxy) {
    return dispatch(opts, handler)
  }

  return dispatch(opts, new Handler(opts.proxy, { handler }))
}

export default () => (dispatch) => proxyRequest()(proxyResponse()(dispatch))
