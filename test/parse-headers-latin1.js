import { test } from 'tap'
import { parseHeaders } from '../lib/index.js'

test('parseHeaders decodes Buffer values as HTTP Latin-1', (t) => {
  const headers = parseHeaders([
    Buffer.from('X-Raw'),
    Buffer.from([0xe9]),
    Buffer.from('X-Raw'),
    [Buffer.from([0xf1]), 'ascii'],
  ])

  t.strictSame(headers, { 'x-raw': ['é', 'ñ', 'ascii'] })
  t.end()
})
