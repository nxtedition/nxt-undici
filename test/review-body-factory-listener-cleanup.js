import { once } from 'node:events'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'tap'
import { request } from '../lib/index.js'

const observedEvents = ['data', 'end', 'error', 'close', 'finish']

function listenerCounts(stream) {
  return Object.fromEntries(observedEvents.map((event) => [event, stream.listenerCount(event)]))
}

test('completed factory body does not retain forwarding or finished listeners', async (t) => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => res.end('ok'))
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const inner = new PassThrough()
  const before = listenerCounts(inner)
  const responsePromise = request(`http://127.0.0.1:${server.address().port}`, {
    method: 'POST',
    body: () => inner,
  })
  inner.end('request body')

  const response = await responsePromise
  await response.body.text()
  await tick()

  t.same(listenerCounts(inner), before, 'all factory-added listeners were removed')
})
