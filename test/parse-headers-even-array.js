import { test } from 'tap'
import { parseHeaders } from '../lib/index.js'

test('parseHeaders rejects odd-length flat header arrays', (t) => {
  t.throws(() => parseHeaders(['x-complete', 'value', 'x-orphan']), {
    name: 'InvalidArgumentError',
    code: 'UND_ERR_INVALID_ARG',
    message: 'headers array must be even',
  })
  t.end()
})
