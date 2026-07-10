import type { DispatchOptions } from '../lib/index.js'

const options: DispatchOptions = {
  origin: [
    'http://one.example.test',
    new URL('http://two.example.test'),
    { protocol: 'http:', hostname: 'three.example.test' },
  ],
}

const readonlyOrigins = [
  'http://one.example.test',
  new URL('http://two.example.test'),
  { protocol: 'http:', hostname: 'three.example.test' },
] as const
const readonlyOptions: DispatchOptions = { origin: readonlyOrigins }

void [options, readonlyOptions]
