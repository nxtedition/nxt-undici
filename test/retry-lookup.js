import { test, after } from 'node:test'
import { request } from '../lib/index.js'
import { once } from 'node:events'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

test('retry with lookup', async () => {
  const server = createServer(async (req, res) => {
    res.statusCode = 400
    res.end()
  })
  after(server.close.bind(server))

  server.listen(0)

  await once(server, 'listening')

  await request({
    method: 'GET',
    origin: 'asd',
    path: '/asd',
    lookup: () => {
      return Promise.resolve(`http://localhost:${server.address().port}`)
    },
  }).catch((err) => {
    assert.strictEqual(err.statusCode, 400)
  })
})
