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

test('retry 503', (t) => {
  t.plan(2)

  const server = createServer(async (req, res) => {
    res.statusCode = 503
    res.end()
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    let n = 0
    try {
      await request(`http://0.0.0.0:${server.address().port}`, {
        retry: (err, retryCount, opts, next) => (n++ < 2 ? next() : null),
      })
      t.fail()
    } catch (err) {
      t.ok(err instanceof Error)
    }
    t.equal(n, 3)
  })
})
