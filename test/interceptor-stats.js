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
