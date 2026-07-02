import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { test } from 'tap'
import { request } from '../lib/index.js'

// ---------------------------------------------------------------------------
// response-retry: the library accepts EventEmitter-style abort signals (see
// RequestHandler in lib/request.js), but the retry backoff wait passed
// opts.signal straight to timers/promises.setTimeout, which requires a real
// AbortSignal and throws ERR_INVALID_ARG_TYPE synchronously otherwise. The
// rejection landed in #maybeError and the request failed with the TypeError
// instead of retrying.
// ---------------------------------------------------------------------------

test('retry: EventEmitter signal does not crash the backoff wait', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(503, {})
      res.end('busy')
    } else {
      res.writeHead(200, {})
      res.end('ok')
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const signal = new EventEmitter()
    signal.aborted = false

    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      signal,
      retry: 3,
    })
    const text = await body.text()

    t.equal(text, 'ok', 'retried past the 503 without ERR_INVALID_ARG_TYPE')
    t.equal(attempts, 2, 'initial attempt + 1 retry')
  })
})

test('retry: EventEmitter signal abort during backoff rejects promptly', (t) => {
  t.plan(3)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    // A long server-controlled backoff: without racing the 'abort' event the
    // request would only settle after the full 30s wait.
    res.writeHead(503, { 'retry-after': '30' })
    res.end('busy')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const signal = new EventEmitter()
    signal.aborted = false

    const start = Date.now()
    setTimeout(() => {
      signal.aborted = true
      signal.reason = new Error('user abort')
      signal.emit('abort')
    }, 200)

    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        signal,
        retry: 3,
      })
      await body.text()
      t.fail('should have rejected')
    } catch (err) {
      const elapsed = Date.now() - start
      t.equal(err.message, 'user abort', 'rejects with the abort reason')
      t.ok(elapsed < 5000, `rejected promptly (${elapsed}ms), not after the 30s retry-after`)
      t.equal(attempts, 1, 'no further attempts after abort')
    }
  })
})

test('retry: AbortSignal abort during backoff still rejects promptly', (t) => {
  t.plan(2)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    res.writeHead(503, { 'retry-after': '30' })
    res.end('busy')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const ac = new AbortController()

    const start = Date.now()
    setTimeout(() => ac.abort(new Error('ac abort')), 200)

    try {
      const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
        signal: ac.signal,
        retry: 3,
      })
      await body.text()
      t.fail('should have rejected')
    } catch {
      const elapsed = Date.now() - start
      t.ok(elapsed < 5000, `rejected promptly (${elapsed}ms), not after the 30s retry-after`)
      t.equal(attempts, 1, 'no further attempts after abort')
    }
  })
})
