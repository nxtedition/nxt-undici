import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'
import { request } from '../lib/request.js'

test('retry callback mutations do not break request trace correlation', async (t) => {
  const docs = []
  const trace = {
    write(doc, op) {
      docs.push({ ...doc, op })
    },
  }
  let attempts = 0

  const dispatch = compose(
    (_opts, handler) => {
      handler.onConnect(() => {})

      if (attempts++ === 0) {
        handler.onError(Object.assign(new Error('retry me'), { code: 'ECONNRESET' }))
        return
      }

      handler.onHeaders(200, { 'content-length': '0' }, () => {})
      handler.onComplete({})
    },
    interceptors.responseRetry(),
    interceptors.log(),
  )

  const { body } = await request(dispatch, {
    id: 'req-original',
    method: 'GET',
    origin: 'http://original.test',
    path: '/resource',
    trace,
    retry(_err, _count, opts, defaultRetry) {
      opts.id = 'req-mutated'
      opts.method = 'PATCH'
      opts.origin = 'http://mutated.test'
      opts.path = '/different'
      return defaultRetry()
    },
  })
  await body.dump()

  t.equal(attempts, 2)

  const requestDocs = docs.filter((doc) => doc.op === 'undici:request')
  const start = requestDocs.find((doc) => doc.phase === 'start')
  const end = requestDocs.find((doc) => doc.phase === 'end')
  const retry = docs.find((doc) => doc.op === 'undici:retry')

  t.equal(requestDocs.length, 2, 'the logical request emits one trace pair')
  t.ok(start, 'the request start trace exists')
  t.ok(end, 'the request end trace exists')
  t.ok(retry, 'the retry trace exists')
  if (!start || !end || !retry) {
    return
  }

  t.match(end, { id: start.id, method: start.method, url: start.url })
  t.match(retry, {
    id: start.id,
    method: start.method,
    url: start.url,
    retryCount: 0,
  })
})

test('successful retry-eligible requests do not resolve retry trace state', (t) => {
  let traceReads = 0
  const dispatch = interceptors.responseRetry()((_opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, { 'content-length': '0' }, () => {})
    handler.onComplete({})
  })

  dispatch(
    {
      method: 'GET',
      retry: true,
      get trace() {
        traceReads++
        return null
      },
    },
    {
      onConnect() {},
      onHeaders() {},
      onComplete() {},
      onError(err) {
        throw err
      },
    },
  )

  t.equal(traceReads, 0)
  t.end()
})
