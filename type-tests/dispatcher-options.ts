import type { Dispatcher, DispatchHandler } from '../lib/index.js'

declare const dispatcher: Dispatcher
declare const handler: DispatchHandler

dispatcher.dispatch({ origin: 'https://example.test', method: 'GET' }, handler)

// @ts-expect-error Dispatcher options use the public DispatchOptions contract.
dispatcher.dispatch({ unknownOption: true }, handler)
