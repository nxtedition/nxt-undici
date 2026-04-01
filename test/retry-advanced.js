/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'

// ---------------------------------------------------------------------------
// Custom retry function
// ---------------------------------------------------------------------------

test('retry: custom retry function receives error and count', (t) => {
  t.plan(3)
  let x = 0
  let callCount = 0

  const server = createServer((req, res) => {
    res.statusCode = x++ ? 200 : 503
    res.end('body')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { statusCode, body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: (err, count, opts, defaultFn) => {
        callCount++
        t.equal(count, 0)
        return defaultFn()
      },
    })
    await body.dump()
    t.equal(statusCode, 200)
    t.equal(callCount, 1)
  })
})

test('retry: custom retry function returning false stops retrying', (t) => {
  t.plan(2)
  const server = createServer((req, res) => {
    res.statusCode = 503
    res.end('fail')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { statusCode, body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: () => false,
        error: false,
      })
      await body.dump()
      t.equal(statusCode, 503)
      t.pass('did not retry')
    } catch (err) {
      t.fail(err.message)
    }
  })
})

// ---------------------------------------------------------------------------
// Max retry count
// ---------------------------------------------------------------------------

test('retry: respects retry count limit', (t) => {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.statusCode = 503
    res.end('fail')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      const { statusCode, body } = await request(`http://0.0.0.0:${server.address().port}`, {
        retry: 2,
        error: false,
      })
      await body.dump()
      // 1 initial + 2 retries = 3 total hits
      t.equal(hits, 3)
      t.equal(statusCode, 503)
      t.end()
    } catch (err) {
      t.fail(err.message)
      t.end()
    }
  })
})

// ---------------------------------------------------------------------------
// Non-idempotent methods are NOT retried
// ---------------------------------------------------------------------------

test('retry: POST is not retried by default', (t) => {
  t.plan(2)
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.statusCode = 503
    res.end('fail')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      await request(`http://0.0.0.0:${server.address().port}`, {
        method: 'POST',
        body: 'data',
        retry: 3,
        error: true,
      })
      t.fail('should have thrown')
    } catch (err) {
      t.equal(hits, 1)
      t.ok(err.statusCode === 503)
    }
  })
})

test('retry: POST is retried when idempotent:true', (t) => {
  t.plan(2)
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.statusCode = hits < 3 ? 503 : 200
    res.end('body')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { statusCode, body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: 'data',
      retry: 3,
      idempotent: true,
    })
    await body.dump()
    t.equal(statusCode, 200)
    t.equal(hits, 3)
  })
})

// ---------------------------------------------------------------------------
// Partial-body retry using Range + ETag
// ---------------------------------------------------------------------------

test('retry: resumes partial body using Range and ETag', (t) => {
  t.plan(4)
  let x = 0
  const server = createServer((req, res) => {
    if (x === 0) {
      // First response: sends partial data then destroys connection
      res.setHeader('etag', '"abc"')
      res.setHeader('content-length', '6')
      res.write('foo')
      setTimeout(() => res.destroy(), 50)
    } else if (x === 1) {
      // Second response: client should send Range header
      t.ok(req.headers.range, 'client sent Range header')
      t.match(req.headers['if-match'], '"abc"', 'client sent If-Match header')
      res.writeHead(206, {
        'content-range': 'bytes 3-5/6',
        'content-length': '3',
        etag: '"abc"',
      })
      res.end('bar')
    }
    x++
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { statusCode, body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: 3,
    })
    const text = await body.text()
    t.equal(statusCode, 200)
    t.equal(text, 'foobar')
  })
})

// ---------------------------------------------------------------------------
// Retry: retry:false disables retrying
// ---------------------------------------------------------------------------

test('retry: retry:false disables all retries', (t) => {
  t.plan(2)
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.statusCode = 503
    res.end('fail')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      await request(`http://0.0.0.0:${server.address().port}`, {
        retry: false,
        error: true,
      })
      t.fail('should have thrown')
    } catch (err) {
      t.equal(hits, 1)
      t.ok(err.statusCode === 503)
    }
  })
})

// ---------------------------------------------------------------------------
// Retry on connection-level errors (socket destroy before headers)
// ---------------------------------------------------------------------------

test('retry: retries on socket destroy before response', (t) => {
  t.plan(3)
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    if (hits === 1) {
      res.destroy()
    } else {
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { statusCode, body } = await request(`http://0.0.0.0:${server.address().port}`, {
      retry: 3,
    })
    await body.dump()
    t.equal(statusCode, 200)
    t.equal(hits, 2)
    t.pass()
  })
})
