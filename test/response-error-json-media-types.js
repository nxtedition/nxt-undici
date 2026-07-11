import { test } from 'tap'
import responseError from '../lib/interceptor/response-error.js'

function captureError(contentType, payload) {
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

test('response errors recognize JSON and text media types case-insensitively', (t) => {
  const upperCase = captureError('Application/JSON; Charset=UTF-8', '{"code":"UPPER"}')
  t.strictSame(upperCase.body, { code: 'UPPER' })
  t.equal(upperCase.code, 'UPPER')

  const problem = captureError('application/problem+json', '{"reason":"bad input"}')
  t.strictSame(problem.body, { reason: 'bad input' })
  t.equal(problem.reason, 'bad input')

  const sequence = captureError('application/json-seq', '{"code":"SEQUENCE"}')
  t.strictSame(sequence.body, { code: 'SEQUENCE' })
  t.equal(sequence.code, 'SEQUENCE')

  const text = captureError('Text/Plain; Charset=UTF-8', 'plain error')
  t.equal(text.body, 'plain error')
  t.end()
})
