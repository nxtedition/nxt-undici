import {
  Agent,
  Client,
  Pool,
  getGlobalDispatcher,
  request,
  setGlobalDispatcher,
} from '../lib/index.js'
import type { Dispatcher, RequestOptions } from '../lib/index.js'

const tls = { rejectUnauthorized: false }
const client = new Client('https://example.test', { tls })
const pool = new Pool('https://example.test', { tls })
const agent = new Agent({ tls })

const clientDispatcher: Dispatcher = client
const poolDispatcher: Dispatcher = pool
const agentDispatcher: Dispatcher = agent
const options: RequestOptions = { dispatcher: agent }

setGlobalDispatcher(agent)
void getGlobalDispatcher()
void request('https://example.test', options)
void clientDispatcher
void poolDispatcher
void agentDispatcher
void options.signal?.reason

new Client('https://example.test', { allowH2: false, maxConcurrentStreams: null })

// @ts-expect-error This fork is HTTP/1.1-only.
new Client('https://example.test', { allowH2: true })

// @ts-expect-error This fork does not support HTTP/2 stream concurrency.
new Client('https://example.test', { maxConcurrentStreams: 12 })
