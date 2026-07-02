/* eslint-disable */
import { test } from 'tap'
import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { request } from '../lib/index.js'
import requestBodyFactory from '../lib/interceptor/request-body-factory.js'

test('pre-connect failure destroys factory stream and aborts factory signal', async (t) => {
  const inner = new PassThrough()
  let signal = null
  let factoryCalls = 0

  try {
    await request('http://127.0.0.1:1', {
      method: 'POST',
      retry: false,
      body: (opts) => {
        factoryCalls++
        signal = opts.signal
        return inner
      },
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err, 'request rejected')
  }

  // Destroy propagation can finish on a later tick.
  await tick()

  t.equal(factoryCalls, 1, 'factory called once')
  t.equal(inner.destroyed, true, 'inner stream destroyed')
  t.equal(signal.aborted, true, 'factory signal aborted')
})

test('every retry attempt destroys its factory stream', async (t) => {
  const streams = []
  const signals = []

  try {
    await request('http://127.0.0.1:1', {
      // PUT so response-retry retries connection errors (POST is not
      // idempotent by default).
      method: 'PUT',
      retry: 2,
      body: ({ signal }) => {
        const inner = new PassThrough()
        streams.push(inner)
        signals.push(signal)
        return inner
      },
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err, 'request rejected')
  }

  await tick()

  t.equal(streams.length, 3, 'factory called once per attempt (1 initial + 2 retries)')
  t.ok(
    streams.every((stream) => stream.destroyed),
    'every attempt stream destroyed',
  )
  t.ok(
    signals.every((signal) => signal.aborted),
    'every attempt signal aborted',
  )
})

test('sync throw from inner dispatch destroys the factory stream', async (t) => {
  const boom = new Error('sync dispatch boom')
  const dispatch = requestBodyFactory()(() => {
    throw boom
  })

  const inner = new PassThrough()
  let signal = null

  t.throws(
    () =>
      dispatch(
        {
          method: 'POST',
          body: (opts) => {
            signal = opts.signal
            return inner
          },
        },
        { onError() {} },
      ),
    boom,
    'error propagates unchanged',
  )

  // The factory runs on nextTick after construction; destroy is deferred
  // until _construct settles.
  await tick()
  await tick()

  t.equal(inner.destroyed, true, 'inner stream destroyed')
  t.equal(signal.aborted, true, 'factory signal aborted')
})

test('signal not aborted on a fully consumed body (happy path)', async (t) => {
  const { createServer } = await import('node:http')

  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.end('ok')
    })
  })
  t.teardown(server.close.bind(server))

  await new Promise((resolve) => server.listen(0, resolve))

  let signal = null
  const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
    method: 'POST',
    body: (opts) => {
      signal = opts.signal
      return 'hello'
    },
  })
  for await (const _ of body) {
    // drain
  }

  await tick()

  t.equal(signal.aborted, false, 'signal untouched after normal completion')
})
