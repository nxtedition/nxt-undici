import type { Dispatcher, DispatchHandler } from '../lib/index.js'

declare const dispatcher: Dispatcher
declare const handler: DispatchHandler

dispatcher.dispatch({ origin: 'https://example.test', method: 'GET' }, handler)
dispatcher.dispatch({ origin: 'https://example.test', dns: { ttl: 0, negativeTTL: 0 } }, handler)

// @ts-expect-error Dispatcher options use the public DispatchOptions contract.
dispatcher.dispatch({ unknownOption: true }, handler)

// @ts-expect-error DNS TTL options are numeric.
dispatcher.dispatch({ origin: 'https://example.test', dns: { ttl: '1000' } }, handler)
