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

test('path with existing "?" throws when query is also provided', async (t) => {
  t.plan(1)
  try {
    await request('http://0.0.0.0:1/test?existing=1', { query: { extra: '2' } })
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /\?/)
  }
})

test('path with "#" is stripped by URL parser — query is applied to the bare path', async (t) => {
  // new URL('http://host/test#hash').pathname === '/test'; # is stripped from path.
  // So the query interceptor never sees a # in the path and no error is thrown.
  // This test documents that behaviour: the '#' guard in serializePathWithQuery is
  // only reachable when opts.path is set directly (not via a URL string).
  t.plan(1)
  const server = createServer((req, res) => {
    res.end(req.url)
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    // URL parser strips the fragment before the path reaches the query interceptor
    const { body } = await request(`http://0.0.0.0:${server.address().port}/test#hash`, {
      query: { key: 'val' },
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, '/test?key=val', 'hash stripped; query appended to bare path')
  })
})
