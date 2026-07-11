import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'
import { request } from '../lib/request.js'

test('follow callback mutations do not rewrite redirect trace provenance', async (t) => {
  const docs = []
  const trace = {
    write(doc, op) {
      docs.push({ ...doc, op })
    },
  }
  const attempts = []

  const dispatch = compose(
    (opts, handler) => {
      attempts.push({ ...opts })
      handler.onConnect(() => {})

      if (attempts.length === 1) {
        handler.onHeaders(302, { location: '/next' }, () => {})
      } else {
        handler.onHeaders(200, { 'content-length': '0' }, () => {})
      }
      handler.onComplete({})
    },
    interceptors.redirect(),
    interceptors.log(),
  )

  const { body } = await request(dispatch, {
    id: 'req-original',
    method: 'GET',
    origin: 'http://original.test',
    path: '/resource',
    trace,
    follow(_location, _count, opts) {
      opts.id = 'req-mutated'
      opts.method = 'PATCH'
      opts.origin = 'http://mutated.test'
      opts.path = '/different'
      return true
    },
  })
  await body.dump()

  t.equal(attempts.length, 2)
  t.match(attempts[1], {
    id: 'req-mutated',
    method: 'PATCH',
    origin: 'http://mutated.test',
    path: '/next',
  })

  const requestDocs = docs.filter((doc) => doc.op === 'undici:request')
  const start = requestDocs.find((doc) => doc.phase === 'start')
  const end = requestDocs.find((doc) => doc.phase === 'end')
  const redirect = docs.find((doc) => doc.op === 'undici:redirect')

  t.equal(requestDocs.length, 2, 'the logical request emits one trace pair')
  t.ok(start, 'the request start trace exists')
  t.ok(end, 'the request end trace exists')
  t.ok(redirect, 'the redirect trace exists')
  if (!start || !end || !redirect) {
    return
  }

  t.match(end, { id: start.id, method: start.method, url: start.url })
  t.match(redirect, {
    id: start.id,
    method: 'PATCH',
    from: start.url,
    to: 'http://mutated.test/next',
    count: 1,
  })
})
