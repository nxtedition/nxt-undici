import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'tap'
import { request } from '../lib/index.js'
import requestBodyFactory from '../lib/interceptor/request-body-factory.js'

const falsyReasons = [
  ['undefined', undefined],
  ['null', null],
  ['false', false],
  ['zero', 0],
  ['empty string', ''],
]

async function captureFactoryStreamError(factory) {
  let body
  const dispatch = requestBodyFactory()((opts) => {
    body = opts.body
  })

  dispatch({ body: factory }, {})

  const error = once(body, 'error', { signal: AbortSignal.timeout(1_000) })
  body.resume()

  try {
    return (await error)[0]
  } finally {
    body.destroy()
  }
}

function assertNormalizedError(t, err, reason) {
  t.type(err, Error)
  t.equal(err.message, 'Request body factory failed')
  t.ok(Object.hasOwn(err, 'cause'), 'the original failure is retained as cause')
  t.equal(err.cause, reason)
}

test('body factory normalizes falsy synchronous throws into stream errors', async (t) => {
  for (const [name, reason] of falsyReasons) {
    await t.test(name, async (t) => {
      const err = await captureFactoryStreamError(() => {
        throw reason
      })
      assertNormalizedError(t, err, reason)
    })
  }
})

test('body factory normalizes falsy asynchronous rejections into stream errors', async (t) => {
  for (const [name, reason] of falsyReasons) {
    await t.test(name, async (t) => {
      const err = await captureFactoryStreamError(() => Promise.reject(reason))
      assertNormalizedError(t, err, reason)
    })
  }
})

test('falsy body factory failures reject real requests promptly', async (t) => {
  const server = createServer((req, res) => {
    req.on('error', () => {})
    res.on('error', () => {})
    req.resume()
    req.on('end', () => res.end())
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const origin = `http://127.0.0.1:${server.address().port}`
  const cases = [
    [
      'synchronous throw',
      undefined,
      () => {
        throw undefined
      },
    ],
    ['asynchronous rejection', null, () => Promise.reject(null)],
  ]

  for (const [name, reason, factory] of cases) {
    await t.test(name, async (t) => {
      try {
        await request(origin, {
          method: 'POST',
          body: factory,
          signal: AbortSignal.timeout(1_000),
          retry: false,
          follow: false,
          cache: false,
          proxy: false,
          verify: false,
          error: false,
        })
        t.fail('request should reject')
      } catch (err) {
        assertNormalizedError(t, err, reason)
      }
    })
  }
})
