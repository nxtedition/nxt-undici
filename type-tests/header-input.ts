import {
  parseHeaders,
  type DispatchOptions,
  type HeaderInput,
  type HeaderPair,
} from '../lib/index.js'

const headers: HeaderInput = ['x-first', 'one', Buffer.from('x-second'), Buffer.from('two')]
const options: DispatchOptions = { headers }
const pairs: readonly HeaderPair[] = [
  ['x-first', 'one'],
  [Buffer.from('x-second'), [Buffer.from('two'), 'three']],
]
const pairOptions: DispatchOptions = { headers: pairs }

parseHeaders()
parseHeaders(null)
parseHeaders(headers)
parseHeaders(pairs)
parseHeaders([
  ['x-pair', 'value'],
  [Buffer.from('x-repeated'), ['one', Buffer.from('two')]],
])
void options
void pairOptions
