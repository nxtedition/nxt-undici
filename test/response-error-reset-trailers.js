import { test } from 'tap'
import responseError from '../lib/interceptor/response-error.js'

test('response-error does not leak trailers across reconnects', (t) => {
  let handler
  const errors = []
  const dispatch = responseError()((_opts, value) => {
    handler = value
  })
  dispatch(
    { error: true, origin: 'http://example.test', path: '/', method: 'GET', headers: {} },
    {
      onError(error) {
        errors.push(error)
      },
    },
  )

  handler.onConnect(() => {})
  handler.onHeaders(500, { 'content-type': 'text/plain' }, () => {})
  handler.onData(Buffer.from('first attempt'))
  handler.onComplete({ 'x-first-trailer': 'present' })

  handler.onConnect(() => {})
  handler.onError(new Error('second attempt transport failure'))

  t.equal(errors.length, 2)
  t.strictSame(errors[0].res.trailers, { 'x-first-trailer': 'present' })
  t.equal(errors[1].res.trailers, null, 'reset trailers use empty response metadata')
  t.end()
})
