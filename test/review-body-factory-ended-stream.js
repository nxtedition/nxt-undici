import { once } from 'node:events'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { test } from 'tap'
import { request } from '../lib/index.js'

test('factory result that already ended completes as an empty body', async (t) => {
  let requestBody = ''
  const server = createServer((req, res) => {
    req.on('data', (chunk) => {
      requestBody += chunk
    })
    req.on('end', () => res.end('ok'))
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('ended factory stream left the request hanging')),
    500,
  )
  t.teardown(() => clearTimeout(timeout))

  const response = await request(`http://127.0.0.1:${server.address().port}`, {
    method: 'POST',
    retry: false,
    signal: controller.signal,
    body: async () => {
      const ended = Readable.from(['already consumed'])
      for await (const chunk of ended) {
        // Exhaust the stream before the factory resolves.
        void chunk
      }
      return ended
    },
  })
  clearTimeout(timeout)

  t.equal(await response.body.text(), 'ok')
  t.equal(requestBody, '', 'the exhausted stream contributes no body bytes')
})
