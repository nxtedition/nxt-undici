import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function respond(handler, statusCode, body) {
  handler.onConnect(() => {})
  handler.onHeaders(statusCode, { 'content-length': String(Buffer.byteLength(body)) }, () => {})
  handler.onData(Buffer.from(body))
  handler.onComplete({})
}

function run(retry) {
  let attempts = 0
  const dispatch = compose((opts, handler) => {
    attempts++
    respond(handler, attempts === 1 ? 503 : 200, attempts === 1 ? 'unavailable' : 'ok')
  }, interceptors.responseRetry())

  return new Promise((resolve, reject) => {
    let statusCode
    dispatch(
      {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
        headers: {},
        retry,
      },
      {
        onConnect() {},
        onHeaders(status) {
          statusCode = status
          return true
        },
        onData() {
          return true
        },
        onComplete() {
          resolve({ attempts, statusCode })
        },
        onError: reject,
      },
    )
  })
}

test('invalid retry budgets disable retries', async (t) => {
  const cases = [
    ['numeric NaN', Number.NaN],
    ['numeric Infinity', Number.POSITIVE_INFINITY],
    ['numeric -Infinity', Number.NEGATIVE_INFINITY],
    ['numeric negative', -1],
    ['numeric fraction', 0.5],
    ['numeric unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['invalid retry type', '2'],
    ['options NaN', { count: Number.NaN }],
    ['options Infinity', { count: Number.POSITIVE_INFINITY }],
    ['options -Infinity', { count: Number.NEGATIVE_INFINITY }],
    ['options negative', { count: -1 }],
    ['options fraction', { count: 0.5 }],
    ['options unsafe integer', { count: Number.MAX_SAFE_INTEGER + 1 }],
    ['options string', { count: '2' }],
    ['options null', { count: null }],
  ]

  for (const [name, retry] of cases) {
    const result = await run(retry)
    t.same(result, { attempts: 1, statusCode: 503 }, name)
  }
})

test('invalid object count caps a custom retry strategy before it is called', async (t) => {
  let strategyCalls = 0
  const result = await run({
    count: Number.NaN,
    retry() {
      strategyCalls++
      return true
    },
  })

  t.equal(strategyCalls, 0)
  t.same(result, { attempts: 1, statusCode: 503 })
})

test('valid retry forms retain their documented semantics', async (t) => {
  const enabled = [
    ['true uses the default budget', true],
    ['numeric shorthand', 1],
    ['options count', { count: 1 }],
    ['omitted options count uses the default', { maxDelay: 0 }],
    ['maximum safe integer is valid', Number.MAX_SAFE_INTEGER],
    ['bare strategy controls retrying', () => true],
  ]

  for (const [name, retry] of enabled) {
    const result = await run(retry)
    t.same(result, { attempts: 2, statusCode: 200 }, name)
  }

  for (const [name, retry] of [
    ['false disables retries', false],
    ['zero shorthand disables retries', 0],
    ['zero options count disables retries', { count: 0 }],
  ]) {
    const result = await run(retry)
    t.same(result, { attempts: 1, statusCode: 503 }, name)
  }
})
