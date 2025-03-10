import { test } from 'tap'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'

test('error', (t) => {
  t.plan(1)

  const server = createServer(async (req, res) => {
    res.statusCode = 500
    res.end()
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      await request(`http://0.0.0.0:${server.address().port}`)
      t.fail()
    } catch (err) {
      t.ok(err instanceof Error)
    }
  })
})
