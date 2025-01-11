import { test } from 'tap'
import { createServer } from 'node:http'
import { request, interceptors, compose } from '../lib/index.js'
import undici from '@nxtedition/undici'

test('cache request', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      dispatcher: compose(new undici.Agent(), interceptors.cache()),
      cache: true,
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'asd')
  })
})
