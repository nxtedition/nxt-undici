import { once } from 'node:events'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { test } from 'tap'
import { request } from '../lib/index.js'

test('follow callback can decline a 307 after a streaming request body', async (t) => {
  let attempts = 0
  let receivedBody = ''
  const server = createServer((req, res) => {
    attempts++
    req.on('data', (chunk) => {
      receivedBody += chunk
    })
    req.on('end', () => {
      res.writeHead(307, { location: '/not-followed' })
      res.end('redirect response')
    })
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  let followCalls = 0
  const response = await request(`http://127.0.0.1:${server.address().port}/start`, {
    method: 'POST',
    body: Readable.from(['streamed body']),
    follow(location, count) {
      followCalls++
      t.equal(location, '/not-followed')
      t.equal(count, 1)
      return false
    },
  })

  t.equal(response.statusCode, 307, 'the declined redirect response is delivered')
  t.equal(await response.body.text(), 'redirect response')
  t.equal(followCalls, 1)
  t.equal(attempts, 1, 'no redirect request was dispatched')
  t.equal(receivedBody, 'streamed body')
})
