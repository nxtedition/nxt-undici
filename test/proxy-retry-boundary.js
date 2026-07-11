import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'tap'
import { request } from '../lib/index.js'

test('proxy sanitizes headers added by a retry callback on every attempt', async (t) => {
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.headers)

    if (requests.length === 1) {
      res.statusCode = 503
      res.end('retry')
      return
    }

    res.end('ok')
  })

  t.teardown(() => server.close())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const { body } = await request(`http://127.0.0.1:${server.address().port}`, {
    proxy: { name: 'edge' },
    retry: (err, retryCount, opts) => {
      t.equal(err.statusCode, 503)
      t.equal(retryCount, 0)

      opts.headers.connection = 'x-secret'
      opts.headers['x-secret'] = 'must-not-leak'
      opts.headers['proxy-authorization'] = 'must-not-leak'
      opts.headers['x-retry-attempt'] = '2'
      return true
    },
  })

  t.equal(await body.text(), 'ok')
  t.equal(requests.length, 2)
  t.not(requests[1].connection, 'x-secret', 'the callback-provided Connection is stripped')
  t.notOk(requests[1]['x-secret'], 'Connection-nominated fields are stripped from the retry')
  t.notOk(requests[1]['proxy-authorization'], 'proxy credentials are stripped from the retry')
  t.equal(requests[1]['x-retry-attempt'], '2', 'ordinary callback mutations are preserved')
  t.same(
    requests.map(({ via }) => via),
    ['HTTP/1.1 edge', 'HTTP/1.1 edge'],
    'Via is rebuilt once per attempt instead of accumulating',
  )
})
