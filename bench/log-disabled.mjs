// Compare log-interceptor mode costs: the explicit disabled fast path, the
// common but still-active shape of a truthy pino logger configured at level
// `silent`, trace-only, and enabled logging. Point BENCH_NXT_UNDICI_ROOT at
// another checkout when a candidate changes this path.
//
// Run with:
//   node --expose-gc bench/log-disabled.mjs
//   BENCH_NXT_UNDICI_ROOT=/path/to/baseline node --expose-gc bench/log-disabled.mjs

import path from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bench, do_not_optimize, group, run, summary } from 'mitata'
import pino from 'pino'

const root = path.resolve(
  process.env.BENCH_NXT_UNDICI_ROOT ?? fileURLToPath(new URL('..', import.meta.url)),
)
const { interceptors } = await import(pathToFileURL(path.join(root, 'lib/index.js')))

console.log(`implementation: ${root}`)

const sink = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  },
})
const silentLogger = pino({ level: 'silent' }, sink)
const infoLogger = pino({ level: 'info' }, sink)
const chunk = Buffer.alloc(1024)
const requestHeaders = {
  accept: 'application/json',
  authorization: 'Bearer benchmark-token',
  cookie: 'session=benchmark-secret',
  host: 'api.example.test',
  'user-agent': 'nxt-undici-benchmark',
  'x-request-id': 'benchmark-request-id',
}
const responseHeaders = {
  'cache-control': 'private, max-age=0',
  'content-length': String(chunk.length),
  'content-type': 'application/json',
  'set-cookie': 'session=benchmark-secret; Secure; HttpOnly',
  vary: 'accept-encoding',
  'x-request-id': 'benchmark-request-id',
}
const downstreamHandler = {
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

function createDispatch(statusCode) {
  return interceptors.log()((_opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(statusCode, responseHeaders, () => {})
    handler.onData(chunk)
    handler.onComplete([])
    return true
  })
}

const dispatch200 = createDispatch(200)
const dispatch500 = createDispatch(500)
const baseOpts = {
  id: 'benchmark-request-id',
  origin: 'https://api.example.test',
  path: '/assets/123',
  method: 'GET',
  headers: requestHeaders,
}
const trace = { write() {} }
const disabledOpts = { ...baseOpts, logger: null, trace: null }
const silentOpts = { ...baseOpts, logger: silentLogger, trace: null }
const traceOpts = { ...baseOpts, logger: null, trace }
const infoOpts = { ...baseOpts, logger: infoLogger, trace: null }

group('log interceptor lifecycle', () => {
  summary(() => {
    bench('explicitly disabled', () =>
      do_not_optimize(dispatch200(disabledOpts, downstreamHandler)),
    )
      .gc('inner')
      .baseline(true)
    bench('pino silent (still active)', () =>
      do_not_optimize(dispatch200(silentOpts, downstreamHandler)),
    ).gc('inner')
    bench('trace only', () => do_not_optimize(dispatch200(traceOpts, downstreamHandler))).gc(
      'inner',
    )
    bench('pino info, 200', () => do_not_optimize(dispatch200(infoOpts, downstreamHandler))).gc(
      'inner',
    )
    bench('pino info, 500', () => do_not_optimize(dispatch500(infoOpts, downstreamHandler))).gc(
      'inner',
    )
  })
})

await run({ colors: false })
