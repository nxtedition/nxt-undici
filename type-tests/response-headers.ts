import type { ServerResponse } from 'node:http'

import { request } from '../lib/index.js'

declare const response: ServerResponse

const upstream = await request('http://example.com')
const headers: Record<string, string | string[]> = upstream.headers

response.writeHead(upstream.statusCode, headers)
