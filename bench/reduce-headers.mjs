// Benchmark + equivalence oracle for the proxy interceptor's `reduceHeaders`.
//
// Run the correctness oracle (every variant must produce byte-identical output
// to the original across an edge-case battery):
//   node bench/reduce-headers.mjs --check
//
// Run the full benchmark (throughput + per-iteration heap allocation):
//   node --expose-gc bench/reduce-headers.mjs
//
// mitata reports `avg ns/iter` (CPU) and a `gc(...)` line whose trailing value
// is bytes allocated per iteration (GC pressure) when --expose-gc is passed.
//
// The variant functions and fixtures are also exported so other scripts can
// reuse them (e.g. to run an independent fixture battery).

import net from 'node:net'
import createError from 'http-errors'
import { run, bench, summary, group } from 'mitata'

// ---------------------------------------------------------------------------
// Shared helpers (identical to lib/interceptor/proxy.js)
// ---------------------------------------------------------------------------

const HOP_EXPR =
  /^(te|host|upgrade|trailers|connection|keep-alive|http2-settings|transfer-encoding|proxy-connection|proxy-authenticate|proxy-authorization)$/i

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

// ASCII case-insensitive equality where `b` is a lowercase literal and
// a.length === b.length is guaranteed by the caller. Allocation-free; matches
// HOP_EXPR's /i semantics for ASCII header tokens.
export function eqiLower(a, b) {
  if (a === b) return true
  for (let i = 0; i < b.length; i++) {
    let c = a.charCodeAt(i)
    if (c >= 0x41 && c <= 0x5a) c += 0x20
    if (c !== b.charCodeAt(i)) return false
  }
  return true
}

// Regex-free, allocation-free equivalent of HOP_EXPR.test(key) for string keys.
export function isHopByHop(key) {
  switch (key.length) {
    case 2:
      return eqiLower(key, 'te')
    case 4:
      return eqiLower(key, 'host')
    case 7:
      return eqiLower(key, 'upgrade')
    case 8:
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

// The post-loop "tail" is identical across every variant; factoring it out
// guarantees variants differ ONLY in how they iterate the headers.
function finishHeaders(acc, fn, via, forwarded, host, authority, socket, proxyName, httpVersion) {
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
        ]
          .filter(Boolean)
          .join(';'),
    )
  } else if (forwarded) {
    throw new createError.BadGateway()
  }

  if (proxyName) {
    if (via) {
      const viaLower = via.toLowerCase()
      const proxyNameLower = proxyName.toLowerCase()
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

// ---------------------------------------------------------------------------
// VARIANTS
// ---------------------------------------------------------------------------

// v0 — the CURRENT (pre-optimization) implementation, verbatim. Ground truth.
export function v0_orig({ headers, proxyName, httpVersion, socket }, fn, acc) {
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
    remove = connection.split(/,\s*/).map((s) => s.trim().toLowerCase())
  }

  for (const [key, val] of Object.entries(headers)) {
    if (key.charAt(0) !== ':' && !remove.includes(key) && !HOP_EXPR.test(key)) {
      acc = fn(acc, key, val.toString())
    }
  }

  return finishHeaders(acc, fn, via, forwarded, host, authority, socket, proxyName, httpVersion)
}

// v1 — Object.keys() computed ONCE, reused across both passes. Keeps regex.
export function v1_keys({ headers, proxyName, httpVersion, socket }, fn, acc) {
  let via = ''
  let forwarded = ''
  let host = ''
  let authority = ''
  let connection = ''

  const keys = Object.keys(headers)

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const len = key.length
    if (len === 3 && !via && key === 'via') {
      via = headers[key]
    } else if (len === 4 && !host && key === 'host') {
      host = headers[key]
    } else if (len === 9 && !forwarded && key === 'forwarded') {
      forwarded = headers[key]
    } else if (len === 10 && !connection && key === 'connection') {
      connection = headers[key]
    } else if (len === 10 && !authority && key === ':authority') {
      authority = headers[key]
    }
  }

  let remove = []
  if (connection && !HOP_EXPR.test(connection)) {
    remove = connection.split(/,\s*/).map((s) => s.trim().toLowerCase())
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (key.charAt(0) !== ':' && !remove.includes(key) && !HOP_EXPR.test(key)) {
      acc = fn(acc, key, headers[key].toString())
    }
  }

  return finishHeaders(acc, fn, via, forwarded, host, authority, socket, proxyName, httpVersion)
}

// v2 — like v1 but the per-key hop check uses isHopByHop (regex-free), the
// Connection-value check reuses isHopByHop too, and the remove-list is lazily
// allocated (null unless Connection lists headers). This mirrors the PERFORMANCE
// shape shipped in lib/interceptor/proxy.js. (proxy.js additionally folds
// duplicate/arrayed special headers via headerValue() — a correctness fix
// exercised by test/proxy-advanced.js, not by these single-valued fixtures.)
export function v2_keys_eqi({ headers, proxyName, httpVersion, socket }, fn, acc) {
  let via = ''
  let forwarded = ''
  let host = ''
  let authority = ''
  let connection = ''

  const keys = Object.keys(headers)

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const len = key.length
    if (len === 3 && !via && key === 'via') {
      via = headers[key]
    } else if (len === 4 && !host && key === 'host') {
      host = headers[key]
    } else if (len === 9 && !forwarded && key === 'forwarded') {
      forwarded = headers[key]
    } else if (len === 10 && !connection && key === 'connection') {
      connection = headers[key]
    } else if (len === 10 && !authority && key === ':authority') {
      authority = headers[key]
    }
  }

  let remove = null
  if (connection) {
    const value = Array.isArray(connection) ? connection.join(',') : connection
    if (!HOP_EXPR.test(value)) {
      remove = value.split(',').map((s) => s.trim().toLowerCase())
    }
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (
      key.charCodeAt(0) !== 0x3a &&
      (remove === null || !remove.includes(key)) &&
      !isHopByHop(key)
    ) {
      acc = fn(acc, key, headers[key].toString())
    }
  }

  return finishHeaders(acc, fn, via, forwarded, host, authority, socket, proxyName, httpVersion)
}

// v3 — for-in iteration (own-enumerable guard), zero keys-array allocation.
export function v3_forin({ headers, proxyName, httpVersion, socket }, fn, acc) {
  let via = ''
  let forwarded = ''
  let host = ''
  let authority = ''
  let connection = ''

  for (const key in headers) {
    if (!Object.hasOwn(headers, key)) continue
    const len = key.length
    if (len === 3 && !via && key === 'via') {
      via = headers[key]
    } else if (len === 4 && !host && key === 'host') {
      host = headers[key]
    } else if (len === 9 && !forwarded && key === 'forwarded') {
      forwarded = headers[key]
    } else if (len === 10 && !connection && key === 'connection') {
      connection = headers[key]
    } else if (len === 10 && !authority && key === ':authority') {
      authority = headers[key]
    }
  }

  let remove = []
  if (connection && !HOP_EXPR.test(connection)) {
    remove = connection.split(/,\s*/).map((s) => s.trim().toLowerCase())
  }

  for (const key in headers) {
    if (!Object.hasOwn(headers, key)) continue
    if (key.charAt(0) !== ':' && !remove.includes(key) && !HOP_EXPR.test(key)) {
      acc = fn(acc, key, headers[key].toString())
    }
  }

  return finishHeaders(acc, fn, via, forwarded, host, authority, socket, proxyName, httpVersion)
}

// v4 — SINGLE pass: capture specials and emit kept headers together; headers
// named by a custom Connection list are deleted afterwards. Regex.
export function v4_single_regex({ headers, proxyName, httpVersion, socket }, fn, acc) {
  let via = ''
  let forwarded = ''
  let host = ''
  let authority = ''
  let connection = ''

  const keys = Object.keys(headers)

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const len = key.length
    if (len === 3 && !via && key === 'via') {
      via = headers[key]
    } else if (len === 4 && !host && key === 'host') {
      host = headers[key]
    } else if (len === 9 && !forwarded && key === 'forwarded') {
      forwarded = headers[key]
    } else if (len === 10 && !connection && key === 'connection') {
      connection = headers[key]
    } else if (len === 10 && !authority && key === ':authority') {
      authority = headers[key]
    }
    if (key.charAt(0) !== ':' && !HOP_EXPR.test(key)) {
      acc = fn(acc, key, headers[key].toString())
    }
  }

  if (connection && !HOP_EXPR.test(connection)) {
    const remove = connection.split(/,\s*/)
    for (let i = 0; i < remove.length; i++) {
      delete acc[remove[i].trim().toLowerCase()]
    }
  }

  return finishHeaders(acc, fn, via, forwarded, host, authority, socket, proxyName, httpVersion)
}

// v5 — single pass + regex-free hop check. Both optimizations combined.
export function v5_single_eqi({ headers, proxyName, httpVersion, socket }, fn, acc) {
  let via = ''
  let forwarded = ''
  let host = ''
  let authority = ''
  let connection = ''

  const keys = Object.keys(headers)

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const len = key.length
    if (len === 3 && !via && key === 'via') {
      via = headers[key]
    } else if (len === 4 && !host && key === 'host') {
      host = headers[key]
    } else if (len === 9 && !forwarded && key === 'forwarded') {
      forwarded = headers[key]
    } else if (len === 10 && !connection && key === 'connection') {
      connection = headers[key]
    } else if (len === 10 && !authority && key === ':authority') {
      authority = headers[key]
    }
    if (key.charCodeAt(0) !== 0x3a && !isHopByHop(key)) {
      acc = fn(acc, key, headers[key].toString())
    }
  }

  if (connection && !HOP_EXPR.test(connection)) {
    const remove = connection.split(/,\s*/)
    for (let i = 0; i < remove.length; i++) {
      delete acc[remove[i].trim().toLowerCase()]
    }
  }

  return finishHeaders(acc, fn, via, forwarded, host, authority, socket, proxyName, httpVersion)
}

export const VARIANTS = [
  ['v0-orig    Object.entries x2 + regex', v0_orig],
  ['v1-keys    Object.keys reuse  + regex', v1_keys],
  ['v2-keysEqi Object.keys reuse  + eqi  ', v2_keys_eqi],
  ['v3-forin   for-in x2          + regex', v3_forin],
  ['v4-1pass   single pass        + regex', v4_single_regex],
  ['v5-1pass   single pass        + eqi  ', v5_single_eqi],
]

// ---------------------------------------------------------------------------
// Accumulator callbacks (identical to the two real call-site closures)
// ---------------------------------------------------------------------------

export const handlerFn = (acc, key, val) => {
  acc[key] = val
  return acc
}

export function makeDispatchFn(method) {
  const expectsPayload =
    method === 'PUT' || method === 'POST' || method === 'PATCH' || method === 'QUERY'
  return (obj, key, val) => {
    if (key === 'content-length' && !expectsPayload) {
      // dropped
    } else if (key[0] === ':') {
      // dropped
    } else if (key === 'expect') {
      // dropped
    } else {
      obj[key] = val
    }
    return obj
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOCKET = {
  localAddress: '10.0.0.1',
  localPort: 8080,
  remoteAddress: '192.168.1.2',
  remotePort: 54321,
  encrypted: false,
}
const SOCKET6 = {
  localAddress: '::1',
  localPort: 8080,
  remoteAddress: '::ffff:192.0.2.1',
  remotePort: 12345,
  encrypted: true,
}

function mk(name, headers, opts = {}) {
  const {
    proxyName = null,
    httpVersion = null,
    socket = null,
    fnKind = 'handler',
    method = 'GET',
  } = opts
  return {
    name,
    input: { headers, proxyName, httpVersion, socket },
    fn: fnKind === 'dispatch' ? makeDispatchFn(method) : handlerFn,
    benchable: opts.benchable !== false,
  }
}

const big = {}
for (let i = 0; i < 30; i++) big[`x-header-${i}`] = `value-${i}-${'a'.repeat(8)}`

export const FIXTURES = [
  mk(
    'request-typical (GET, 12 hdrs)',
    {
      host: 'example.com',
      'user-agent': 'Mozilla/5.0 (compatible)',
      accept: 'text/html,application/xhtml+xml',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      cookie: 'session=abc123; theme=dark',
      referer: 'https://example.com/page',
      'content-length': '0',
      'x-request-id': '8f3c2a1b-1234-5678',
      dnt: '1',
    },
    { fnKind: 'dispatch', method: 'GET' },
  ),
  mk(
    'request-post (payload, content-length kept)',
    {
      host: 'api.example.com',
      'content-type': 'application/json',
      'content-length': '128',
      accept: '*/*',
      authorization: 'Bearer xyz',
      connection: 'keep-alive',
    },
    { fnKind: 'dispatch', method: 'POST' },
  ),
  mk('response-typical (12 hdrs)', {
    'content-type': 'text/html; charset=utf-8',
    'content-length': '4096',
    date: 'Mon, 07 Jun 2026 12:00:00 GMT',
    server: 'nginx/1.25.0',
    'cache-control': 'public, max-age=3600',
    etag: '"abc-123"',
    vary: 'Accept-Encoding',
    connection: 'close',
    'keep-alive': 'timeout=5',
    'set-cookie': 'sid=1; Path=/; HttpOnly',
    'x-powered-by': 'Express',
    'access-control-allow-origin': '*',
  }),
  mk('response-multivalue (array set-cookie)', {
    'content-type': 'application/json',
    'set-cookie': ['a=1; Path=/', 'b=2; Path=/', 'c=3; Path=/'],
    'x-dup': ['one', 'two'],
    date: 'Mon, 07 Jun 2026 12:00:00 GMT',
  }),
  mk(
    'mixed-case-hop (Connection/TE/Upgrade)',
    {
      Host: 'example.com',
      Connection: 'keep-alive',
      TE: 'trailers',
      Upgrade: 'h2c',
      'X-Custom': 'preserved',
      Accept: 'text/html',
    },
    { fnKind: 'dispatch', method: 'GET' },
  ),
  mk(
    'connection-custom-list',
    {
      connection: 'x-foo, x-bar',
      'x-foo': 'remove-me',
      'x-bar': 'remove-me-too',
      'x-keep': 'keep',
      accept: '*/*',
    },
    { fnKind: 'dispatch', method: 'GET' },
  ),
  mk(
    'connection-custom-case-leak',
    {
      connection: 'x-foo',
      'X-Foo': 'leaks-through',
      'x-keep': 'keep',
    },
    { fnKind: 'dispatch', method: 'GET' },
  ),
  mk(
    'pseudo-headers stripped',
    {
      ':authority': 'auth.example.com',
      ':path': '/x',
      ':method': 'GET',
      'x-keep': 'keep',
    },
    { fnKind: 'dispatch', method: 'GET' },
  ),
  mk(
    'via-append (different proxy)',
    { via: 'HTTP/1.1 otherproxy', 'x-keep': 'k' },
    {
      proxyName: 'myproxy',
      httpVersion: '1.1',
    },
  ),
  mk(
    'forwarded+socket (combine)',
    { forwarded: 'for=1.2.3.4', 'x-keep': 'k' },
    {
      socket: SOCKET,
    },
  ),
  mk('socket+host', { host: 'myhost.example.com', 'x-keep': 'k' }, { socket: SOCKET }),
  mk(
    'socket+:authority (priority over host)',
    { ':authority': 'authority.example.com', host: 'ignored.example.com', 'x-keep': 'k' },
    { socket: SOCKET6 },
  ),
  mk('large (30 hdrs)', big),
  mk('empty + proxyName (adds via)', {}, { proxyName: 'myproxy', httpVersion: '1.1' }),
  mk('array-via no proxyName', { via: ['HTTP/1.1 a', 'HTTP/1.1 b'], 'x-keep': 'k' }),
  // Throwing fixtures (oracle-only; not benchmarked)
  mk(
    'THROW via-loop (LoopDetected)',
    { via: 'HTTP/1.1 myproxy', 'x-keep': 'k' },
    {
      proxyName: 'myproxy',
      httpVersion: '1.1',
      benchable: false,
    },
  ),
  mk(
    'THROW forwarded no socket (BadGateway)',
    { forwarded: 'for=1.2.3.4', 'x-keep': 'k' },
    {
      benchable: false,
    },
  ),
]

// ---------------------------------------------------------------------------
// Equivalence oracle
// ---------------------------------------------------------------------------

export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (!deepEqual(ka, kb)) return false
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false
    return true
  }
  return false
}

export function runOnce(variant, input, fn) {
  try {
    return { kind: 'ok', result: variant(input, fn, {}) }
  } catch (err) {
    return { kind: 'throw', name: err.constructor.name, status: err.status ?? err.statusCode }
  }
}

export function resultsEqual(a, b) {
  if (a.kind !== b.kind) return false
  if (a.kind === 'throw') return a.name === b.name && a.status === b.status
  return deepEqual(a.result, b.result)
}

function checkEquivalence() {
  let failures = 0
  for (const fx of FIXTURES) {
    const baseline = runOnce(v0_orig, fx.input, fx.fn)
    for (const [label, variant] of VARIANTS) {
      if (variant === v0_orig) continue
      const got = runOnce(variant, fx.input, fx.fn)
      if (!resultsEqual(baseline, got)) {
        failures++
        console.error(`\n  x MISMATCH  [${label.trim()}]  fixture="${fx.name}"`)
        console.error(`      expected: ${JSON.stringify(baseline)}`)
        console.error(`      got:      ${JSON.stringify(got)}`)
      }
    }
  }
  if (failures === 0) {
    console.log(
      `OK equivalence: all ${VARIANTS.length - 1} variants match v0-orig across ${FIXTURES.length} fixtures`,
    )
  } else {
    console.error(`\nx equivalence: ${failures} mismatch(es)\n`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Entry point — only when invoked directly
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith('reduce-headers.mjs')) {
  checkEquivalence()

  if (!process.argv.includes('--check')) {
    for (const fx of FIXTURES) {
      if (!fx.benchable) continue
      group(fx.name, () => {
        summary(() => {
          for (const [label, variant] of VARIANTS) {
            const b = bench(label, function* () {
              const input = fx.input
              const fn = fx.fn
              yield () => variant(input, fn, {})
            }).gc('inner')
            if (variant === v0_orig) b.baseline(true)
          }
        })
      })
    }
    await run({ colors: false })
  }
}
