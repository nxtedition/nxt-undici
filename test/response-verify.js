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

test('verify detects content-length mismatch via interceptor unit test', (t) => {
  // The HTTP transport enforces content-length framing so a real server cannot
  // easily trigger the interceptor's mismatch path.  Test the interceptor directly.
  t.plan(2)

  import('../lib/interceptor/response-verify.js').then(({ default: responseVerify }) => {
    const interceptor = responseVerify()

    let capturedError
    const fakeHandler = {
      onConnect(abort) {},
      onHeaders(sc, headers, resume) {
        return true
      },
      onData(chunk) {},
      onComplete(trailers) {},
      onError(err) {
        capturedError = err
      },
    }

    const fakeDispatch = (opts, handler) => {
      handler.onConnect(() => {})
      handler.onHeaders(200, { 'content-length': '100' }, () => {})
      handler.onData(Buffer.from('hello world')) // 11 bytes, not 100
      handler.onComplete({})
    }

    const dispatch = interceptor(fakeDispatch)
    dispatch({ verify: { size: true }, method: 'GET' }, fakeHandler)

    t.ok(capturedError?.message.includes('Content-Length mismatch'))
    t.equal(capturedError?.expected, 100)
  })
})

test('verify passes when content-length header is absent', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello world')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      verify: { size: true },
    })
    const chunks = []
    for await (const chunk of body) {
      chunks.push(chunk)
    }
    t.equal(Buffer.concat(chunks).toString(), 'hello world')
  })
})

test('verify passes when content-md5 header is absent', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello world')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      verify: { hash: true },
    })
    const chunks = []
    for await (const chunk of body) {
      chunks.push(chunk)
    }
    t.equal(Buffer.concat(chunks).toString(), 'hello world')
  })
})
