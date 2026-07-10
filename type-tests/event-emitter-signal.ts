import { EventEmitter } from 'node:events'
import type { DispatchOptions, LookupFn, RequestOptions } from '../lib/index.js'

const signal = new EventEmitter()
const requestOptions: RequestOptions = { signal }
const dispatchOptions: DispatchOptions = { signal }
const lookup: LookupFn = (_origin, _options, callback) => {
  callback(null, 'http://resolved.example.test')
}
lookup('http://service.example.test', { signal }, () => {})

void [requestOptions, dispatchOptions]
