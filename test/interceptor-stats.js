import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function rawRequest(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    const chunks = []
    dispatch(opts, {
      onConnect() {},
      onHeaders(status) {
        statusCode = status
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.from(chunk))
      },
      onComplete() {
        resolve({ statusCode, body: Buffer.concat(chunks).toString() })
      },
      onError: reject,
    })
  })
}

function complete(handler, statusCode = 200, headers = {}) {
  handler.onConnect(() => {})
  handler.onHeaders(statusCode, headers, () => {})
  handler.onComplete([])
}

function noopHandler() {
  return {
    onConnect() {},
    onHeaders() {
      return true
    },
    onData() {},
    onComplete() {},
    onError(err) {
      throw err
    },
  }
}

test('priority stats expose live per-origin scheduler queues', (t) => {
  const priority = interceptors.priority()
  const handlers = []
  const dispatch = priority((_opts, handler) => handlers.push(handler))
  const opts = {
    origin: 'http://example.test',
    path: '/',
    method: 'GET',
    headers: {},
    priority: 'high',
  }

  dispatch(opts, noopHandler())
  dispatch(opts, noopHandler())

  t.match(priority.stats(), [
    {
      origin: 'http://example.test',
      running: 1,
      concurrency: 1,
      pending: 1,
      total: { count: 1, deferred: 1, completed: 0 },
    },
  ])

  handlers[0].onConnect(() => {})
  t.match(priority.stats(), [
    {
      running: 1,
      pending: 0,
      total: { count: 0, deferred: 1, completed: 1 },
    },
  ])

  handlers[1].onConnect(() => {})
  t.same(priority.stats(), [], 'idle schedulers are still evicted')
  t.end()
})

test('redirect stats count accepted redirect hops', async (t) => {
  const redirect = interceptors.redirect()
  const dispatch = redirect((opts, handler) => {
    if (opts.path === '/start') {
      complete(handler, 302, { location: '/next' })
    } else {
      complete(handler)
    }
  })

  const result = await rawRequest(dispatch, {
    origin: 'http://example.test',
    path: '/start',
    method: 'GET',
    headers: {},
    follow: 1,
  })

  t.equal(result.statusCode, 200)
  t.same(redirect.stats(), { followed: 1 })
})

test('retry stats count pending decisions, actual attempts, and outcomes', async (t) => {
  const retry = interceptors.responseRetry()
  let attempts = 0
  let decide
  const decision = new Promise((resolve) => {
    decide = resolve
  })
  const dispatch = retry((_opts, handler) => {
    attempts++
    complete(handler, attempts === 1 ? 503 : 200)
  })

  const response = rawRequest(dispatch, {
    origin: 'http://example.test',
    path: '/',
    method: 'GET',
    headers: {},
    retry: () => decision,
  })

  await new Promise((resolve) => setImmediate(resolve))
  t.same(retry.stats(), {
    retries: 0,
    headerRetries: 0,
    bodyRetries: 0,
    recovered: 0,
    failed: 0,
    aborted: 0,
    pending: 1,
  })

  decide(true)
  t.equal((await response).statusCode, 200)
  t.same(retry.stats(), {
    retries: 1,
    headerRetries: 1,
    bodyRetries: 0,
    recovered: 1,
    failed: 0,
    aborted: 0,
    pending: 0,
  })

  let failedAttempts = 0
  const failedDispatch = retry((_opts, handler) => {
    failedAttempts++
    complete(handler, 503)
  })
  t.equal(
    (
      await rawRequest(failedDispatch, {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
        headers: {},
        retry: 1,
      })
    ).statusCode,
    503,
  )
  t.equal(failedAttempts, 2)
  t.match(retry.stats(), {
    retries: 2,
    headerRetries: 2,
    recovered: 1,
    failed: 1,
    pending: 0,
  })
})

test('retry stats distinguish body-resume retries', async (t) => {
  const retry = interceptors.responseRetry()
  let attempts = 0
  const dispatch = retry((opts, handler) => {
    attempts++
    handler.onConnect(() => {})
    if (attempts === 1) {
      handler.onHeaders(200, { 'content-length': '5', etag: '"v1"' }, () => {})
      handler.onData(Buffer.from('he'))
      handler.onError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      return
    }

    t.equal(opts.headers.range, 'bytes=2-4')
    handler.onHeaders(
      206,
      { 'content-range': 'bytes 2-4/5', 'content-length': '3', etag: '"v1"' },
      () => {},
    )
    handler.onData(Buffer.from('llo'))
    handler.onComplete([])
  })

  const response = await rawRequest(dispatch, {
    origin: 'http://example.test',
    path: '/',
    method: 'GET',
    headers: {},
    retry: 1,
  })

  t.equal(response.body, 'hello')
  t.same(retry.stats(), {
    retries: 1,
    headerRetries: 0,
    bodyRetries: 1,
    recovered: 1,
    failed: 0,
    aborted: 0,
    pending: 0,
  })
})

test('retry stats distinguish caller aborts after a retry', async (t) => {
  const retry = interceptors.responseRetry()
  const reason = new Error('stop')
  const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
  let attempts = 0
  let abortRequest
  const dispatch = retry((_opts, handler) => {
    attempts++
    handler.onConnect((abortReason) => handler.onError(abortReason))
    if (attempts === 1) {
      handler.onError(reset)
    } else {
      abortRequest(reason)
    }
  })

  const err = await new Promise((resolve) => {
    dispatch(
      {
        origin: 'http://example.test',
        path: '/',
        method: 'GET',
        headers: {},
        retry: 1,
      },
      {
        onConnect(abort) {
          abortRequest = abort
        },
        onError: resolve,
      },
    )
  })

  t.equal(err, reason)
  t.same(retry.stats(), {
    retries: 1,
    headerRetries: 1,
    bodyRetries: 0,
    recovered: 0,
    failed: 0,
    aborted: 1,
    pending: 0,
  })
})

test('dns stats distinguish cache hits, misses, negative hits, and resolver work', async (t) => {
  const dns = interceptors.dns()
  const dispatch = dns((_opts, handler) => complete(handler))
  const lookup = (hostname, _opts, callback) => {
    if (hostname === 'missing.test') {
      callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND', hostname }))
    } else {
      callback(null, [{ address: '127.0.0.1', family: 4 }])
    }
  }
  const opts = (hostname) => ({
    origin: `http://${hostname}`,
    path: '/',
    method: 'GET',
    headers: {},
    dns: { lookup, ttl: 60e3, negativeTTL: 60e3 },
  })

  await rawRequest(dispatch, opts('service.test'))
  await rawRequest(dispatch, opts('service.test'))
  await t.rejects(rawRequest(dispatch, opts('missing.test')), { code: 'ENOTFOUND' })
  await t.rejects(rawRequest(dispatch, opts('missing.test')), { code: 'ENOTFOUND' })

  t.same(dns.stats(), {
    hits: 1,
    misses: 2,
    negativeHits: 1,
    lookups: 2,
    refreshes: 0,
    errors: 1,
    evictions: 0,
    pending: 0,
  })
})

test('lookup stats expose in-flight and failed logical-origin resolutions', async (t) => {
  const lookup = interceptors.lookup()
  const dispatch = lookup((_opts, handler) => complete(handler))
  let callback
  const pending = rawRequest(dispatch, {
    origin: 'http://service.test',
    lookup(_origin, _opts, cb) {
      callback = cb
    },
  })

  t.same(lookup.stats(), { lookups: 1, errors: 0, pending: 1 })
  callback(null, 'http://127.0.0.1')
  await pending

  await t.rejects(
    rawRequest(dispatch, {
      origin: 'http://missing.test',
      lookup(_origin, _opts, cb) {
        cb(new Error('lookup failed'))
      },
    }),
    { message: 'lookup failed' },
  )

  t.same(lookup.stats(), { lookups: 2, errors: 1, pending: 0 })
})
