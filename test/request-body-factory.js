/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'

test('body factory with string', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.end(body)
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: () => 'hello from factory',
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'hello from factory')
  })
})

test('body factory with Buffer', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.end(body)
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: () => Buffer.from('buffer body'),
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'buffer body')
  })
})

test('body factory with async function', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.end(body)
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: async () => 'async body',
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'async body')
  })
})
