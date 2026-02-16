/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'

test('query params are serialized', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end(req.url)
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}/test`, {
      query: { foo: 'bar', baz: '123' },
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, '/test?foo=bar&baz=123')
  })
})

test('empty query object does not add ?', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end(req.url)
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}/test`, {
      query: {},
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, '/test')
  })
})

test('no query option passes path as-is', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end(req.url)
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}/test`)
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, '/test')
  })
})
