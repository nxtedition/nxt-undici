import { EventEmitter } from 'node:events'
import type { RequestOptions } from '../lib/index.js'

const options: RequestOptions = { signal: new EventEmitter() }

void options
