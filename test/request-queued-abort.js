import { createServer } from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'tap'
import { Agent, request } from '../lib/index.js'

test('a pre-aborted request rejects without reaching the dispatcher', async (t) => {
  const controller = new AbortController()
  const reason = { message: 'already aborted' }
  controller.abort(reason)
  const requestBody = new PassThrough()

  let dispatches = 0
  const dispatcher = {
    dispatch() {
      dispatches++
    },
  }

  const result = await request('http://example.test', {
    dispatcher,
    body: requestBody,
    signal: controller.signal,
  }).catch((err) => err)

  t.equal(result, reason)
  t.equal(dispatches, 0)
  if (!requestBody.closed) {
    await once(requestBody, 'close')
  }
  t.equal(requestBody.destroyed, true)
  t.equal(requestBody.errored?.cause, reason, 'stream cleanup uses an Error carrying the reason')
})

test('a non-Error abort before onConnect safely cleans up the request body', async (t) => {
  const controller = new AbortController()
  const reason = 'abort as a string'
  const requestBody = new PassThrough()
  let dispatches = 0
  const dispatcher = {
    dispatch() {
      dispatches++
    },
  }

  const pending = request('http://example.test', {
    dispatcher,
    body: requestBody,
    dns: false,
    lookup: false,
    signal: controller.signal,
  })
  t.equal(dispatches, 1, 'the dispatcher queued the request without connecting it')
  controller.abort(reason)

  const result = await pending.catch((err) => err)
  t.equal(result, reason, 'the public rejection retains the exact caller reason')
  if (!requestBody.closed) {
    await once(requestBody, 'close')
  }
  t.equal(requestBody.destroyed, true)
  t.equal(requestBody.errored?.cause, reason, 'stream cleanup receives a native Error')
})

test('aborting an Agent-queued request rejects before a connection is available', async (t) => {
  let firstResponse
  let requestCount = 0
  let markFirstSeen
  const firstSeen = new Promise((resolve) => {
    markFirstSeen = resolve
  })
  const server = createServer((_req, res) => {
    requestCount++
    if (firstResponse == null) {
      firstResponse = res
      markFirstSeen()
    } else {
      t.fail('the aborted queued request reached the server')
      res.end('unexpected request')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const agent = new Agent({ connections: 1, pipelining: 1 })
  t.teardown(async () => {
    firstResponse?.destroy()
    await agent.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const origin = `http://127.0.0.1:${server.address().port}`
  const first = request(origin, { dispatcher: agent, dns: false, retry: false })
  await firstSeen

  const controller = new AbortController()
  const reason = new Error('abort while queued')
  const queued = request(origin, {
    dispatcher: agent,
    dns: false,
    retry: false,
    signal: controller.signal,
  })
  controller.abort(reason)

  const timeout = Symbol('timeout')
  const result = await Promise.race([queued.catch((err) => err), delay(500, timeout)])
  t.equal(result, reason, 'the queued request rejects with the exact abort reason')

  firstResponse.end('first')
  const { body } = await first
  await body.dump()
  await delay(20)
  t.equal(requestCount, 1, 'the aborted queued request is never written to the server')
})
