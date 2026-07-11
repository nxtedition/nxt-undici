import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

test('range resume replaces mixed-case Range and If-Match headers', async (t) => {
  let attempts = 0
  let retryHeaders
  const dispatch = compose((opts, handler) => {
    attempts++
    handler.onConnect(() => {})

    if (attempts === 1) {
      handler.onHeaders(200, { 'content-length': '6', etag: '"current"' }, () => {})
      handler.onData(Buffer.from('abc'))
      const error = new Error('connection reset')
      error.code = 'ECONNRESET'
      handler.onError(error)
    } else {
      retryHeaders = opts.headers
      handler.onHeaders(206, { 'content-range': 'bytes 3-5/6', etag: '"current"' }, () => {})
      handler.onData(Buffer.from('def'))
      handler.onComplete({})
    }
  }, interceptors.responseRetry())

  const chunks = []
  await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
        headers: {
          Range: 'bytes=0-5',
          'If-Match': '"stale"',
          'X-Test': 'preserved',
        },
        retry: () => true,
      },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData(chunk) {
          chunks.push(chunk)
          return true
        },
        onComplete: resolve,
        onError: reject,
      },
    )
  })

  t.equal(attempts, 2)
  t.equal(retryHeaders.range, 'bytes=3-5', 'resume range replaces the caller range')
  t.equal(retryHeaders['if-match'], '"current"', 'resume validator replaces the stale one')
  t.equal(retryHeaders['x-test'], 'preserved', 'unrelated header is normalized and retained')
  t.notOk('Range' in retryHeaders, 'mixed-case Range is not duplicated')
  t.notOk('If-Match' in retryHeaders, 'mixed-case If-Match is not duplicated')
  t.equal(Buffer.concat(chunks).toString(), 'abcdef')
})
