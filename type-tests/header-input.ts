import { parseHeaders, type DispatchOptions, type HeaderInput } from '../lib/index.js'

const headers: HeaderInput = ['x-first', 'one', Buffer.from('x-second'), Buffer.from('two')]
const options: DispatchOptions = { headers }

parseHeaders()
parseHeaders(null)
parseHeaders(headers)
void options
