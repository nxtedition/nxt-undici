/* eslint-disable */
import { test } from 'tap'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'

test('verify passes on correct content-length', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    const body = 'hello world'
    res.writeHead(200, {
      'content-length': Buffer.byteLength(body),
      'content-type': 'text/plain',
    })
    res.end(body)
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      verify: { size: true },
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'hello world')
  })
})

test('verify passes on correct content-md5', (t) => {
  t.plan(1)
  const body = 'hello world'
  const md5 = crypto.createHash('md5').update(body).digest('base64')

  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-md5': md5,
      'content-type': 'text/plain',
    })
    res.end(body)
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body: resBody } = await request(`http://0.0.0.0:${server.address().port}`, {
      verify: { hash: true },
    })
    let str = ''
    for await (const chunk of resBody) {
      str += chunk
    }
    t.equal(str, 'hello world')
  })
})

test('verify detects content-md5 mismatch', (t) => {
  t.plan(2)
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-md5': 'invalidhash==',
      'content-type': 'text/plain',
    })
    res.end('hello world')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        verify: { hash: true },
        retry: false,
        error: false,
      })
      for await (const chunk of body) {
        // consume
      }
      t.fail('should have thrown')
    } catch (err) {
      t.ok(err.message.includes('Content-MD5 mismatch'))
      t.equal(err.message, 'Response Content-MD5 mismatch')
    }
  })
})

test('verify skipped for HEAD requests', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-length': '100',
      'content-md5': 'invalidhash==',
    })
    res.end()
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'HEAD',
      verify: true,
    })
    t.equal(statusCode, 200)
  })
})

test('verify with both hash and size enabled', (t) => {
  t.plan(1)
  const body = 'test content'
  const md5 = crypto.createHash('md5').update(body).digest('base64')

  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-length': Buffer.byteLength(body),
      'content-md5': md5,
      'content-type': 'text/plain',
    })
    res.end(body)
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body: resBody } = await request(`http://0.0.0.0:${server.address().port}`, {
      verify: true,
    })
    let str = ''
    for await (const chunk of resBody) {
      str += chunk
    }
    t.equal(str, 'test content')
  })
})
