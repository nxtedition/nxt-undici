/* eslint-disable */
import { createServer } from 'node:http'
import { test } from 'tap'
import { request } from '../lib/index.js'

// Custom retry that returns true immediately (no delay) for faster tests
function fastRetry(err, retryCount, opts, defaultRetry) {
  return true
}

// Custom retry with a max count and no delay
function fastRetryMax(max) {
  return (err, retryCount) => retryCount < max
}

test('retry respects max retry count', (t) => {
  t.plan(1)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    res.statusCode = 503
    res.end('unavailable')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: fastRetryMax(2),
        error: false,
      })
      await body.dump()
    } catch {
      // expected
    }
    t.equal(attempts, 3, 'should be initial + 2 retries = 3 attempts')
  })
})

test('retry does not retry on 4xx (except 420, 429)', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    res.statusCode = 404
    res.end('not found')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: true,
      })
      await body.dump()
      t.fail('should have thrown')
    } catch (err) {
      t.equal(err.statusCode, 404)
      t.equal(attempts, 1, 'should not retry 404')
    }
  })
})

test('retry retries on 429', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.statusCode = 429
      res.end('rate limited')
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    await body.dump()
    t.equal(statusCode, 200)
    t.equal(attempts, 2)
  })
})

test('retry retries on 502', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.statusCode = 502
      res.end('bad gateway')
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    await body.dump()
    t.equal(statusCode, 200)
    t.equal(attempts, 2)
  })
})

test('retry retries on 504', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.statusCode = 504
      res.end('gateway timeout')
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    await body.dump()
    t.equal(statusCode, 200)
    t.equal(attempts, 2)
  })
})

test('retry does not retry POST by default', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    res.statusCode = 503
    res.end('unavailable')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        method: 'POST',
        body: 'data',
        retry: fastRetry,
      })
      await body.dump()
      t.fail('should have thrown')
    } catch (err) {
      t.equal(err.statusCode, 503)
      t.equal(attempts, 1, 'should not retry POST')
    }
  })
})

test('retry retries POST when idempotent is true', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.statusCode = 503
      res.end('unavailable')
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: 'data',
      idempotent: true,
      retry: fastRetry,
    })
    await body.dump()
    t.equal(statusCode, 200)
    t.equal(attempts, 2)
  })
})

test('retry is disabled when retry: false', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    res.statusCode = 503
    res.end('unavailable')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: false,
        error: false,
      })
      const text = await body.text()
      t.equal(text, 'unavailable')
    } catch {
      t.pass()
    }
    t.equal(attempts, 1, 'should not retry when retry: false')
  })
})

test('retry with custom retry function receives correct arguments', (t) => {
  t.plan(4)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.statusCode = 503
      res.end('unavailable')
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: (err, retryCount, opts, defaultRetry) => {
        t.ok(err, 'error is passed')
        t.equal(retryCount, 0, 'retryCount starts at 0')
        t.equal(typeof defaultRetry, 'function', 'defaultRetry is a function')
        return true
      },
    })
    await body.dump()
    t.equal(statusCode, 200)
  })
})

test('retry mid-stream with etag uses range request', (t) => {
  t.plan(4)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '10',
        etag: '"test-etag"',
      })
      res.write('hello')
      setTimeout(() => res.destroy(), 50)
    } else if (attempts === 2) {
      t.equal(req.headers['if-match'], '"test-etag"')
      t.ok(req.headers.range, 'should have range header')
      res.writeHead(206, {
        'content-range': 'bytes 5-9/10',
        etag: '"test-etag"',
      })
      res.end('world')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    t.equal(statusCode, 200)
    const text = await body.text()
    t.equal(text, 'helloworld')
  })
})

test('retry does not retry mid-stream without etag', (t) => {
  t.plan(1)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '10',
      })
      res.write('hello')
      setTimeout(() => res.destroy(), 50)
    } else {
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: fastRetry,
      })
      await body.text()
      t.fail('should have thrown')
    } catch {
      t.equal(attempts, 1, 'should not retry mid-stream without etag')
    }
  })
})

test('retry does not retry weak etag mid-stream', (t) => {
  t.plan(1)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '10',
        etag: 'W/"weak-etag"',
      })
      res.write('hello')
      setTimeout(() => res.destroy(), 50)
    } else {
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: fastRetry,
      })
      await body.text()
      t.fail('should have thrown')
    } catch {
      t.equal(attempts, 1, 'should not retry mid-stream with weak etag')
    }
  })
})

test('retry multiple pre-response failures', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts <= 2) {
      res.statusCode = 503
      res.end('unavailable')
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    await body.dump()
    t.equal(statusCode, 200)
    t.equal(attempts, 3)
  })
})

test('retry retries on connection reset', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      req.socket.destroy()
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    await body.dump()
    t.equal(statusCode, 200)
    t.equal(attempts, 2)
  })
})

test('retry does not retry DELETE by default', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    res.statusCode = 503
    res.end('unavailable')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        method: 'DELETE',
        retry: fastRetry,
      })
      await body.dump()
      t.fail('should have thrown')
    } catch (err) {
      t.equal(err.statusCode, 503)
      t.equal(attempts, 1, 'should not retry DELETE')
    }
  })
})

test('retry custom function can block retries', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    res.statusCode = 503
    res.end('unavailable')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: () => false,
      })
      await body.dump()
      t.fail('should have thrown')
    } catch (err) {
      t.equal(err.statusCode, 503)
      t.equal(attempts, 1, 'custom retry returning false should prevent retries')
    }
  })
})

test('retry 500 does not trigger retry (only 502/503/504)', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    res.statusCode = 500
    res.end('internal error')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: true,
      })
      await body.dump()
      t.fail('should have thrown')
    } catch (err) {
      t.equal(err.statusCode, 500)
      t.equal(attempts, 1, 'should not retry 500')
    }
  })
})

// ─── Mid-stream range retry data integrity tests ───

test('mid-stream retry: exact byte position in range header', (t) => {
  t.plan(3)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '20',
        etag: '"etag-1"',
      })
      // Send exactly 7 bytes then destroy
      res.write('1234567')
      setTimeout(() => res.destroy(), 50)
    } else {
      // Verify the range header asks for bytes starting at position 7
      t.equal(
        req.headers.range,
        'bytes=7-19',
        'range should start at byte 7 and end at 19 (inclusive)',
      )
      t.equal(req.headers['if-match'], '"etag-1"', 'if-match should carry the etag')
      res.writeHead(206, {
        'content-range': 'bytes 7-19/20',
        'content-length': '13',
        etag: '"etag-1"',
      })
      res.end('89abcdefghijk')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    const text = await body.text()
    t.equal(
      text,
      '123456789abcdefghijk',
      'full body should be concatenated without gaps or overlaps',
    )
  })
})

test('mid-stream retry: single byte first chunk', (t) => {
  t.plan(1)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '5',
        etag: '"e1"',
      })
      res.write('A')
      setTimeout(() => res.destroy(), 50)
    } else {
      res.writeHead(206, {
        'content-range': 'bytes 1-4/5',
        'content-length': '4',
        etag: '"e1"',
      })
      res.end('BCDE')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    const text = await body.text()
    t.equal(text, 'ABCDE', 'single byte first chunk should produce complete body')
  })
})

test('mid-stream retry: failure at second-to-last byte', (t) => {
  t.plan(1)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '5',
        etag: '"e2"',
      })
      // Send 4 of 5 bytes
      res.write('ABCD')
      setTimeout(() => res.destroy(), 50)
    } else {
      res.writeHead(206, {
        'content-range': 'bytes 4-4/5',
        'content-length': '1',
        etag: '"e2"',
      })
      res.end('E')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    const text = await body.text()
    t.equal(text, 'ABCDE', 'should resume from exact position and produce complete body')
  })
})

test('mid-stream retry: multiple consecutive mid-stream failures', (t) => {
  t.plan(1)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '15',
        etag: '"multi"',
      })
      res.write('ABCDE')
      setTimeout(() => res.destroy(), 50)
    } else if (attempts === 2) {
      res.writeHead(206, {
        'content-range': 'bytes 5-14/15',
        'content-length': '10',
        etag: '"multi"',
      })
      // Send 3 more bytes then fail again
      res.write('FGH')
      setTimeout(() => res.destroy(), 50)
    } else if (attempts === 3) {
      res.writeHead(206, {
        'content-range': 'bytes 8-14/15',
        'content-length': '7',
        etag: '"multi"',
      })
      res.end('IJKLMNO')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    const text = await body.text()
    t.equal(text, 'ABCDEFGHIJKLMNO', 'multiple mid-stream retries should produce complete body')
  })
})

test('mid-stream retry: binary data integrity', (t) => {
  t.plan(1)

  // Create a known binary pattern: 0x00, 0x01, ..., 0xFF
  const fullBody = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) fullBody[i] = i

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '256',
        etag: '"binary"',
      })
      // Send first 100 bytes
      res.write(fullBody.subarray(0, 100))
      setTimeout(() => res.destroy(), 50)
    } else {
      res.writeHead(206, {
        'content-range': 'bytes 100-255/256',
        'content-length': '156',
        etag: '"binary"',
      })
      res.end(fullBody.subarray(100))
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    const chunks = []
    for await (const chunk of body) {
      chunks.push(chunk)
    }
    const result = Buffer.concat(chunks)
    t.ok(result.equals(fullBody), 'binary data should match byte-for-byte after mid-stream retry')
  })
})

test('mid-stream retry: etag mismatch on retry aborts', (t) => {
  t.plan(1)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '10',
        etag: '"v1"',
      })
      res.write('hello')
      setTimeout(() => res.destroy(), 50)
    } else {
      // Server returns different etag — content changed
      res.writeHead(206, {
        'content-range': 'bytes 5-9/10',
        'content-length': '5',
        etag: '"v2"',
      })
      res.end('world')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: fastRetry,
      })
      await body.text()
      t.fail('should have thrown on etag mismatch')
    } catch {
      t.pass('correctly errored on etag mismatch during mid-stream retry')
    }
  })
})

test('mid-stream retry: no content-range in retry response aborts', (t) => {
  t.plan(1)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(200, {
        'content-length': '10',
        etag: '"cr"',
      })
      res.write('hello')
      setTimeout(() => res.destroy(), 50)
    } else {
      // Return 200 without content-range (server doesn't support ranges)
      res.writeHead(200, {
        'content-length': '10',
        etag: '"cr"',
      })
      res.end('helloworld')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: fastRetry,
      })
      await body.text()
      t.fail('should have errored when retry response has no content-range')
    } catch {
      t.pass('correctly errored when retry response lacks content-range')
    }
  })
})

test('mid-stream retry: unknown content-length uses open-ended range', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      // Chunked response (no content-length)
      res.writeHead(200, {
        etag: '"chunked"',
        'transfer-encoding': 'chunked',
      })
      res.write('hello')
      setTimeout(() => res.destroy(), 50)
    } else {
      // Range should be open-ended since we didn't know total size
      t.match(req.headers.range, /^bytes=5-$/, 'range should be open-ended')
      res.writeHead(206, {
        'content-range': 'bytes 5-9/10',
        'content-length': '5',
        etag: '"chunked"',
      })
      res.end('world')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: fastRetry,
    })
    const text = await body.text()
    t.equal(text, 'helloworld', 'should resume correctly with open-ended range')
  })
})
