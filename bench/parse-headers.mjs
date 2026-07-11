// Compare an ordinary defensive parse with the trusted-snapshot fast path.
//
// Run with:
//   node --expose-gc bench/parse-headers.mjs

// Sizes cover a header-light request through a deliberately large request.

import { bench, group, run, summary } from 'mitata'
import { createNormalizedHeaders, parseHeaders } from '../lib/utils.js'

for (const size of [0, 4, 16, 64]) {
  const headers = {}
  for (let i = 0; i < size; i++) {
    headers[`x-header-${i}`] = `value-${i}`
  }
  const normalized = createNormalizedHeaders(headers)

  group(`${size} headers`, () => {
    summary(() => {
      bench('untrusted copy', () => parseHeaders(headers))
        .gc('inner')
        .baseline(true)
      bench('trusted no-op', () => parseHeaders(normalized)).gc('inner')
    })
  })
}

await run({ colors: false })
