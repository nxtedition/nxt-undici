import type { Dispatcher, RequestOptions } from '../lib/index.js'

const dispatcher: Dispatcher = {
  dispatch() {},
}
const options: RequestOptions = { dispatch: dispatcher }

void options
