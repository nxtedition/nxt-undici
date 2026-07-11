import { once } from 'node:events'
import { createServer } from 'node:http'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'tap'
import { request } from '../lib/index.js'
import requestBodyFactory from '../lib/interceptor/request-body-factory.js'

test('aborting a request aborts a still-pending body factory', async (t) => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => res.end('ok'))
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const reason = new Error('stop pending factory')
  const controller = new AbortController()
  let factorySignal
  let factoryAbortCalls = 0

  const pendingRequest = request(`http://127.0.0.1:${server.address().port}`, {
    method: 'PUT',
    retry: false,
    signal: controller.signal,
    body: ({ signal }) => {
      factorySignal = signal
      queueMicrotask(() => controller.abort(reason))
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            factoryAbortCalls++
            reject(signal.reason)
          },
          { once: true },
        )
      })
    },
  })

  await t.rejects(pendingRequest, reason)
  await tick()

  t.equal(factorySignal.aborted, true, 'factory cancellation signal was aborted')
  t.equal(factorySignal.reason, reason, 'factory received the request abort reason')
  t.equal(factoryAbortCalls, 1, 'factory cancellation ran exactly once')
})

test('destroy before _construct gives a pending factory an aborted signal', async (t) => {
  const reason = new Error('synchronous dispatch failure')
  const dispatch = requestBodyFactory()(() => {
    throw reason
  })
  let factorySignal
  let factoryAbortCalls = 0

  t.throws(
    () =>
      dispatch(
        {
          method: 'PUT',
          body: ({ signal }) => {
            factorySignal = signal
            return new Promise((resolve, reject) => {
              if (signal.aborted) {
                factoryAbortCalls++
                reject(signal.reason)
              } else {
                signal.addEventListener(
                  'abort',
                  () => {
                    factoryAbortCalls++
                    reject(signal.reason)
                  },
                  { once: true },
                )
              }
            })
          },
        },
        { onError() {} },
      ),
    reason,
  )

  // FactoryStream construction is scheduled on the next tick.
  await tick()
  await tick()

  t.equal(factorySignal.aborted, true, 'factory started with an aborted signal')
  t.equal(factorySignal.reason, reason, 'synchronous failure was retained as the reason')
  t.equal(factoryAbortCalls, 1, 'factory observed cancellation once')
})
