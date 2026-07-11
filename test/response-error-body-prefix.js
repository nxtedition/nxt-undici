import { test } from 'tap'
import responseError from '../lib/interceptor/response-error.js'

const LIMIT = 256 * 1024

function captureBody(chunks) {
  let error
  const dispatch = responseError()((_opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(500, { 'content-type': 'text/plain' }, () => {})
    for (const chunk of chunks) {
      handler.onData(chunk)
    }
    handler.onComplete({})
  })

  dispatch(
    {
      error: true,
      origin: 'http://example.test',
      path: '/',
      method: 'GET',
      headers: {},
    },
    {
      onError(err) {
        error = err
      },
    },
  )
  return error.body
}

test('response-error retains the prefix of a chunk crossing the body cap', (t) => {
  const prefix = Buffer.alloc(LIMIT - 2, 0x61)
  const body = captureBody([prefix, Buffer.from('WXYZ')])

  t.equal(Buffer.byteLength(body), LIMIT)
  t.equal(body.slice(-2), 'WX')
  t.end()
})

test('response-error retains a capped prefix from one oversized chunk', (t) => {
  const body = captureBody([Buffer.alloc(LIMIT + 1, 0x62)])

  t.equal(Buffer.byteLength(body), LIMIT)
  t.equal(body[0], 'b')
  t.equal(body.at(-1), 'b')
  t.end()
})
