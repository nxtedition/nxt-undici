/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'

test('pre abort signal w/ reason', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const ac = new AbortController()
    const _err = new Error()
    ac.abort(_err)
    try {
      await request(`http://0.0.0.0:${server.address().port}`, { signal: ac.signal })
    } catch (err) {
      t.equal(err, _err)
    }
  })
})

test('post abort signal', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const ac = new AbortController()
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, { signal: ac.signal })
    ac.abort()
    try {
      /* eslint-disable-next-line no-unused-vars */
      for await (const chunk of body) {
        // Do nothing...
      }
    } catch (err) {
      t.equal(err.name, 'AbortError')
    }
  })
})

test('post abort signal w/ reason', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const ac = new AbortController()
    const _err = new Error()
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, { signal: ac.signal })
    ac.abort(_err)
    try {
      /* eslint-disable-next-line no-unused-vars */
      for await (const chunk of body) {
        // Do nothing...
      }
    } catch (err) {
      t.equal(err, _err)
    }
  })
})
