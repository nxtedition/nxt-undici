import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'tap'
import { request } from '../lib/index.js'

test('invalid ISO Retry-After date falls back to configured backoff', async (t) => {
  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(503, {
        // Retry-After permits an HTTP-date, not ISO 8601. Date.parse accepts
        // this extension and used to turn it into an unintended 60s wait.
        'retry-after': new Date(Date.now() + 60_000).toISOString(),
      })
      res.end('unavailable')
    } else {
      res.end('ok')
    }
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('invalid Retry-After was incorrectly honored')),
    500,
  )
  t.teardown(() => clearTimeout(timeout))

  const response = await request(`http://127.0.0.1:${server.address().port}`, {
    retry: { count: 1, maxDelay: 0 },
    signal: controller.signal,
  })
  clearTimeout(timeout)

  t.equal(response.statusCode, 200)
  t.equal(await response.body.text(), 'ok')
  t.equal(attempts, 2, 'invalid date used the zero-delay fallback')
})
