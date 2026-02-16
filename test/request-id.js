/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'

test('request-id header is set', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end(req.headers['request-id'] ?? '')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`)
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.ok(str.startsWith('req-'), `expected request-id to start with "req-", got "${str}"`)
  })
})

test('request-id is unique across requests', (t) => {
  t.plan(1)
  const ids = []
  const server = createServer((req, res) => {
    ids.push(req.headers['request-id'])
    res.end('ok')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    for (let i = 0; i < 3; i++) {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`)
      for await (const chunk of body) {
        // consume
      }
    }
    const uniqueIds = new Set(ids)
    t.equal(uniqueIds.size, 3, 'all request-ids should be unique')
  })
})

test('request-id chains with existing id', (t) => {
  t.plan(2)
  const server = createServer((req, res) => {
    res.end(req.headers['request-id'] ?? '')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      id: 'parent-123',
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.ok(str.startsWith('parent-123,req-'), `expected chained id, got "${str}"`)
    t.ok(str.includes(','), 'should contain comma separator')
  })
})
