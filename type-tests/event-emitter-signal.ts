import { EventEmitter } from 'node:events'
import type { DispatchOptions, LookupFn, RequestOptions } from '../lib/index.js'

const signal = new EventEmitter()
const requestOptions: RequestOptions = { signal }
const dispatchOptions: DispatchOptions = { signal }
const lookup: LookupFn = (_origin, _options, callback) => {
  callback(null, '127.0.0.1')
}
lookup('http://service.example.test', { signal }, () => {})

const eventTargetOptions: RequestOptions = { signal: new EventTarget() }
const onOffOptions: RequestOptions = {
  signal: {
    on(_type, _listener) {},
    off(_type, _listener) {},
  },
}
const onRemoveListenerOptions: RequestOptions = {
  signal: {
    aborted: false,
    reason: undefined,
    on(_type, _listener) {},
    removeListener(_type, _listener) {},
  },
}

const mismatchedOptions: RequestOptions = {
  // @ts-expect-error Registration and cleanup must use a matching protocol.
  signal: {
    addEventListener(_type, _listener) {},
    removeListener(_type, _listener) {},
  },
}

void [
  requestOptions,
  dispatchOptions,
  eventTargetOptions,
  onOffOptions,
  onRemoveListenerOptions,
  mismatchedOptions,
]
