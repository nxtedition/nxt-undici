import type { Dispatcher as TransportDispatcher } from '@nxtedition/undici'
import type { Dispatcher } from '../lib/index.js'

declare const dispatcher: Dispatcher
declare const handler: TransportDispatcher.DispatchHandler

dispatcher.dispatch({ origin: 'https://example.test', path: '/', method: 'GET' }, handler)

// @ts-expect-error Raw transport dispatch requires a request path.
dispatcher.dispatch({ origin: 'https://example.test', method: 'GET' }, handler)

dispatcher.dispatch(
  {
    origin: 'https://example.test',
    path: '/',
    method: 'GET',
    // @ts-expect-error Higher-level interceptor options are consumed before transport dispatch.
    dns: { ttl: 0 },
  },
  handler,
)
