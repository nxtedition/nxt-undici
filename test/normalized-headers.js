import { test } from 'tap'
import { interceptors } from '../lib/index.js'
import { createNormalizedHeaders, invalidateNormalizedHeaders, parseHeaders } from '../lib/utils.js'

test('parseHeaders only reuses internally trusted snapshots', (t) => {
  const publicResult = parseHeaders({ 'X-Count': 1 })
  const publicCopy = parseHeaders(publicResult)

  t.not(publicCopy, publicResult, 'ordinary public results retain copy isolation')
  t.equal(publicCopy['x-count'], '1')

  const trusted = createNormalizedHeaders({ 'X-Count': 1 })
  t.equal(parseHeaders(trusted), trusted, 'trusted input takes the identity fast path')

  t.end()
})

test('fresh snapshots and invalidation cannot trust stale mutations', (t) => {
  const escaped = createNormalizedHeaders({ 'X-Original': 1 })

  // Simulate an object escaping to user code while it still carries internal
  // trust. The public request boundary must force a fresh parse regardless.
  escaped['Mixed-Case'] = 2
  const fresh = createNormalizedHeaders(escaped)
  t.not(fresh, escaped)
  t.strictSame(fresh, { 'x-original': '1', 'mixed-case': '2' })

  invalidateNormalizedHeaders(escaped)
  escaped['Another-Mixed'] = 3
  const reparsed = parseHeaders(escaped)
  t.not(reparsed, escaped, 'invalidated input is parsed instead of reused')
  t.equal(reparsed['another-mixed'], '3')

  t.end()
})

test('log redaction force-copies trusted wire headers', (t) => {
  const headers = createNormalizedHeaders({
    Authorization: 'Bearer secret',
    'X-Safe': 'visible',
  })
  let bindings
  let dispatchedHeaders
  const logger = {
    child(value) {
      bindings = value
      return this
    },
    debug() {},
    error() {},
  }
  const dispatch = interceptors.log()((opts, handler) => {
    dispatchedHeaders = opts.headers
    handler.onConnect(() => {})
    handler.onComplete(null)
  })

  dispatch(
    {
      id: 'req-1',
      origin: 'http://example.test',
      path: '/',
      method: 'GET',
      headers,
      logger,
      trace: null,
    },
    {},
  )

  t.equal(dispatchedHeaders, headers, 'logging does not replace the wire snapshot')
  t.equal(headers.authorization, 'Bearer secret', 'wire credentials remain intact')
  t.equal(bindings.ureq.headers.authorization, '[redacted]', 'log credentials are redacted')
  t.not(bindings.ureq.headers, headers, 'redaction uses an isolated copy')
  t.end()
})

test('functional follow invalidates headers before user code', (t) => {
  const headers = createNormalizedHeaders({ 'X-Safe': 'yes' })
  let called = false
  const dispatch = interceptors.redirect()((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(302, { location: '/next' }, () => {})
    handler.onComplete(null)
  })

  dispatch(
    {
      origin: 'http://example.test',
      path: '/',
      method: 'GET',
      headers,
      follow(location, count, opts) {
        called = true
        opts.headers['Mixed-Case'] = 2
        const reparsed = parseHeaders(opts.headers)
        t.not(reparsed, opts.headers)
        t.equal(reparsed['mixed-case'], '2')
        return false
      },
    },
    {
      onConnect() {},
      onHeaders() {},
      onComplete() {},
      onError(err) {
        t.fail(`unexpected redirect error: ${err?.message ?? err}`)
      },
    },
  )

  t.equal(called, true)
  t.end()
})

test('functional retry invalidates headers before user code', async (t) => {
  const headers = createNormalizedHeaders({ 'X-Safe': 'yes' })
  let called = false
  const dispatch = interceptors.responseRetry()((opts, handler) => {
    handler.onConnect(() => {})
    handler.onError(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }))
  })

  await new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
        headers,
        retry(err, retryCount, opts) {
          called = true
          t.equal(this, opts, 'retry callbacks receive the live options as their receiver')
          opts.headers['Mixed-Case'] = 2
          const reparsed = parseHeaders(opts.headers)
          t.not(reparsed, opts.headers)
          t.equal(reparsed['mixed-case'], '2')
          return false
        },
      },
      {
        onConnect() {},
        onError() {
          resolve()
        },
        onComplete() {
          reject(new Error('unexpected completion'))
        },
      },
    )
  })

  t.equal(called, true)
})
