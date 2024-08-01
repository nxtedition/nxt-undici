import { test } from 'tap'
import { createServer } from 'node:http'
import undici from 'undici'
import { interceptors } from '../lib/index.js'

test('cache request', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await undici.request(`http://0.0.0.0:${server.address().port}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache: true,
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'asd')
  })
})
