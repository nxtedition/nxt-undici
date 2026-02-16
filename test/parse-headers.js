/* eslint-disable */
import { test } from 'tap'
import { parseHeaders } from '../lib/utils.js'

test('parse rawheaders', (t) => {
  const headers = parseHeaders([
    Buffer.from('Content-Type'),
    Buffer.from('application/json'),
    Buffer.from('Content-Length'),
    Buffer.from('10'),
  ])
  t.strictSame(headers, {
    'content-type': 'application/json',
    'content-length': '10',
  })

  t.end()
})
