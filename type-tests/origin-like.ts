import type { DispatchOptions, URLObject } from '../lib/index.js'

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

const readonlyUrlObject = {
  protocol: 'http:',
  hostname: 'readonly.example.test',
  port: 8080,
} as const
const urlObject: URLObject = readonlyUrlObject

void [options, readonlyOptions, urlObject]
