import { test } from 'tap'
import responseError from '../lib/interceptor/response-error.js'

function captureError(payload, contentType = 'application/json') {
  let error
  const dispatch = responseError()((_opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(400, { 'content-type': contentType }, () => {})
    handler.onData(Buffer.from(payload))
    handler.onComplete({})
  })

  dispatch(
    { error: true, origin: 'http://example.test', path: '/', method: 'GET', headers: {} },
    {
      onError(err) {
        error = err
      },
    },
  )
  return error
}

test('response errors retain valid falsy JSON bodies', (t) => {
  for (const [payload, expected] of [
    ['false', false],
    ['0', 0],
    ['""', ''],
  ]) {
    const error = captureError(payload)
    t.equal(Object.hasOwn(error, 'body'), true, `${payload} is attached`)
    t.equal(error.body, expected)
  }
  t.end()
})

test('response errors do not attach an uncaptured body', (t) => {
  const error = captureError('binary data', 'application/octet-stream')

  t.equal(Object.hasOwn(error, 'body'), false)
  t.end()
})

test('response errors do not attach a decoded JSON null body', (t) => {
  const error = captureError('null')

  t.equal(Object.hasOwn(error, 'body'), false)
  t.end()
})
