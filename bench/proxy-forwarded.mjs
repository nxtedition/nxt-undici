// Measure the production public proxy interceptor's combined request-header
// path, including defensive normalization and Forwarded synthesis. Point
// BENCH_NXT_UNDICI_ROOT at another checkout for a matched before/after
// comparison.
//
// Run with:
//   node --expose-gc bench/proxy-forwarded.mjs
//   BENCH_NXT_UNDICI_ROOT=/path/to/baseline node --expose-gc bench/proxy-forwarded.mjs

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

const root = path.resolve(
  process.env.BENCH_NXT_UNDICI_ROOT ?? fileURLToPath(new URL('..', import.meta.url)),
)
const { interceptors } = await import(pathToFileURL(path.join(root, 'lib/index.js')))

console.log(`implementation: ${root}`)

const handler = {
  onConnect() {},
  onHeaders() {
    return true
  },
  onData() {},
  onComplete() {},
  onError(err) {
    throw err
  },
}

function createCase(opts, expectedForwarded) {
  const dispatch = interceptors.proxy()((innerOpts) => innerOpts.headers)
  const invoke = () => dispatch(opts, handler)
  assert.equal(invoke().forwarded, expectedForwarded)
  return invoke
}

const cases = [
  [
    'sparse socket',
    createCase(
      {
        origin: 'http://upstream.test',
        path: '/',
        method: 'GET',
        headers: {},
        proxy: { socket: { encrypted: false } },
      },
      'proto=http',
    ),
  ],
  [
    'IPv4 with host',
    createCase(
      {
        origin: 'http://upstream.test',
        path: '/assets/123',
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer benchmark-token',
          host: 'api.example.test',
          'x-request-id': 'benchmark-request-id',
        },
        proxy: {
          socket: {
            encrypted: true,
            localAddress: '192.0.2.1',
            localPort: 443,
            remoteAddress: '198.51.100.2',
            remotePort: 1234,
          },
        },
      },
      'by="192.0.2.1:443";for="198.51.100.2:1234";proto=https;host="api.example.test"',
    ),
  ],
  [
    'IPv6 with authority',
    createCase(
      {
        origin: 'https://upstream.test',
        path: '/search?q=benchmark',
        method: 'POST',
        headers: {
          ':authority': '[2001:db8::3]:8443',
          ':scheme': 'https',
          accept: 'application/json',
          connection: 'keep-alive',
          forwarded: 'for=192.0.2.60;proto=http',
          'x-request-id': 'benchmark-request-id',
        },
        proxy: {
          socket: {
            encrypted: true,
            localAddress: '2001:db8::1',
            localPort: 443,
            remoteAddress: '2001:db8::2',
            remotePort: 4321,
          },
        },
      },
      'for=192.0.2.60;proto=http, by="[2001:db8::1]:443";for="[2001:db8::2]:4321";proto=https;host="[2001:db8::3]:8443"',
    ),
  ],
]

group('proxy request headers', () => {
  summary(() => {
    for (const [name, invoke] of cases) {
      bench(name, () => do_not_optimize(invoke())).gc('inner')
    }
  })
})

await run({ colors: false })
