import type { Dispatcher, RequestOptions } from '../lib/index.js'

const dispatcher: Dispatcher = {
  dispatch() {},
}
const asyncDispatcher: Dispatcher = {
  async dispatch() {},
}
const options: RequestOptions = { dispatch: dispatcher }
const asyncOptions: RequestOptions = { dispatch: asyncDispatcher }

void [options, asyncOptions]
