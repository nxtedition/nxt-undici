// Compare an ordinary defensive parse with the trusted-snapshot fast path.
//
// Run with:
//   node --expose-gc bench/parse-headers.mjs
//   BENCH_NXT_UNDICI_ROOT=/path/to/baseline node --expose-gc bench/parse-headers.mjs

// Sizes cover a header-light request through a deliberately large request.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

const root = path.resolve(
  process.env.BENCH_NXT_UNDICI_ROOT ?? fileURLToPath(new URL('..', import.meta.url)),
)
const { createNormalizedHeaders, parseHeaders } = await import(
  pathToFileURL(path.join(root, 'lib/utils.js'))
)

console.log(`implementation: ${root}`)

for (const size of [0, 4, 16, 64]) {
  const headers = {}
  for (let i = 0; i < size; i++) {
    headers[`x-header-${i}`] = `value-${i}`
  }
  const normalized = createNormalizedHeaders(headers)

  group(`${size} headers`, () => {
    summary(() => {
      bench('untrusted copy', () => do_not_optimize(parseHeaders(headers)))
        .gc('inner')
        .baseline(true)
      bench('trusted no-op', () => do_not_optimize(parseHeaders(normalized))).gc('inner')
    })
  })
}

await run({ colors: false })
