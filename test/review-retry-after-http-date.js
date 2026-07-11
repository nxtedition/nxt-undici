import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'tap'
import { compose, interceptors, request } from '../lib/index.js'

async function captureSecondRetryDelay(t, retryAfter) {
  let attempts = 0
  const dispatch = compose((opts, handler) => {
    attempts++
    handler.onConnect(() => {})
    handler.onHeaders(503, attempts === 2 ? { 'retry-after': retryAfter } : {}, () => {})
    handler.onComplete({})
  }, interceptors.responseRetry())

  const stop = new Error('retry delay captured')
  let abort
  let retryDoc
  const trace = {
    write(doc, op) {
      if (op === 'undici:retry' && doc.retryCount === 1) {
        retryDoc = doc
        abort(stop)
      }
    },
  }

  await t.rejects(
    new Promise((resolve, reject) => {
      dispatch(
        {
          origin: 'http://example.test',
          path: '/',
          method: 'GET',
          headers: {},
          retry: { count: 2, maxDelay: 200 },
          trace,
        },
        {
          onConnect(value) {
            abort = value
          },
          onHeaders() {
            return true
          },
          onData() {
            return true
          },
          onComplete: resolve,
          onError: reject,
        },
      )
    }),
    { message: stop.message },
  )
  t.equal(attempts, 2, 'captured the retry decision before another attempt')
  return retryDoc.delayMs
}

test('invalid ISO Retry-After date falls back to configured backoff', async (t) => {
  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(503, {
        // Retry-After permits an HTTP-date, not ISO 8601. Date.parse accepts
        // this extension and used to turn it into an unintended 60s wait.
        'retry-after': new Date(Date.now() + 60_000).toISOString(),
      })
      res.end('unavailable')
    } else {
      res.end('ok')
    }
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('invalid Retry-After was incorrectly honored')),
    5_000,
  )
  t.teardown(() => clearTimeout(timeout))

  const response = await request(`http://127.0.0.1:${server.address().port}`, {
    retry: { count: 1, maxDelay: 0 },
    signal: controller.signal,
  })
  clearTimeout(timeout)

  t.equal(response.statusCode, 200)
  t.equal(await response.body.text(), 'ok')
  t.equal(attempts, 2, 'invalid date used the zero-delay fallback')
})

test('signed and fractional Retry-After values fall back to retry policy', async (t) => {
  for (const value of ['-1', '+1', '1.5', '1 0']) {
    const delay = await captureSecondRetryDelay(t, value)
    t.ok(delay >= 100 && delay < 200, `${value} used the configured fallback (${delay}ms)`)
  }
})

test('Retry-After accepts delay-seconds digits and clamps huge values', async (t) => {
  t.equal(await captureSecondRetryDelay(t, '0'), 0, 'zero delay-seconds is valid')
  t.equal(await captureSecondRetryDelay(t, '1'), 1_000, 'positive delay-seconds is valid')
  t.equal(
    await captureSecondRetryDelay(t, ' \t1\t '),
    1_000,
    'optional whitespace around delay-seconds is ignored',
  )
  t.equal(
    await captureSecondRetryDelay(t, '9'.repeat(400)),
    60_000,
    'arbitrarily large delay-seconds remains valid and is clamped',
  )
})

test('Retry-After arrays use their first field occurrence', async (t) => {
  t.equal(await captureSecondRetryDelay(t, ['1']), 1_000, 'single-value arrays are honored')
  t.equal(
    await captureSecondRetryDelay(t, ['1', '9']),
    1_000,
    'the first duplicate determines the delay',
  )

  const fallback = await captureSecondRetryDelay(t, ['-1', '1'])
  t.ok(
    fallback >= 100 && fallback < 200,
    `an invalid first duplicate falls back instead of scanning later values (${fallback}ms)`,
  )
})

test('Retry-After continues to accept an HTTP date', async (t) => {
  const date = new Date(Date.now() + 60_000).toUTCString()
  const delay = await captureSecondRetryDelay(t, ` \t${date}\t `)
  t.ok(delay >= 58_000 && delay <= 60_000, `future HTTP date produced a ${delay}ms delay`)
})
