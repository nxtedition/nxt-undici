import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const ORIGIN = 'http://ttl-policy.test'

function request(dispatch, dns) {
  return new Promise((resolve, reject) => {
    let statusCode
    dispatch(
      { origin: ORIGIN, path: '/', method: 'GET', headers: {}, dns },
      {
        onConnect() {},
        onHeaders(value) {
          statusCode = value
          return true
        },
        onData() {},
        onComplete() {
          resolve(statusCode)
        },
        onError: reject,
      },
    )
  })
}

function makeDispatch(origins) {
  return interceptors.dns()((opts, handler) => {
    origins.push(opts.origin)
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  })
}

function pendingLookup() {
  const calls = []
  const lookup = (hostname, options, callback) => {
    calls.push({ hostname, callback })
  }
  return { calls, lookup }
}

function notFound(hostname) {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname,
  })
}

test('dns: concurrent positive lookups retain independent TTL policies', async (t) => {
  const origins = []
  const { calls, lookup } = pendingLookup()
  const dispatch = makeDispatch(origins)
  const short = { lookup, ttl: 30_000, negativeTTL: 1000 }
  const long = { lookup, ttl: 60_000, negativeTTL: 1000 }

  const shortRequest = request(dispatch, short)
  const longRequest = request(dispatch, long)

  t.equal(calls.length, 2, 'different TTL policies do not share first-caller in-flight state')
  calls[0].callback(null, [{ address: '192.0.2.1', family: 4 }])
  calls[1].callback(null, [{ address: '192.0.2.2', family: 4 }])
  t.same(await Promise.all([shortRequest, longRequest]), [200, 200])

  await request(dispatch, short)
  await request(dispatch, long)
  t.equal(calls.length, 2, 'each policy reuses only its own positive cache entry')
  t.same(origins, ['http://192.0.2.1', 'http://192.0.2.2', 'http://192.0.2.1', 'http://192.0.2.2'])
})

test('dns: concurrent negative lookups retain independent negative-TTL policies', async (t) => {
  const origins = []
  const { calls, lookup } = pendingLookup()
  const dispatch = makeDispatch(origins)
  const longNegative = { lookup, ttl: 60_000, negativeTTL: 60_000 }
  const shortNegative = { lookup, ttl: 60_000, negativeTTL: 1000 }

  const failingRequest = request(dispatch, longNegative)
  const successfulRequest = request(dispatch, shortNegative)

  t.equal(
    calls.length,
    2,
    'different negative-TTL policies do not share first-caller in-flight state',
  )
  calls[0].callback(notFound(calls[0].hostname))
  calls[1].callback(null, [{ address: '192.0.2.10', family: 4 }])

  await t.rejects(failingRequest, { code: 'ENOTFOUND' })
  t.equal(await successfulRequest, 200)

  await t.rejects(request(dispatch, longNegative), { code: 'ENOTFOUND' })
  t.equal(await request(dispatch, shortNegative), 200)
  t.equal(calls.length, 2, 'negative and positive entries remain scoped to their policy')
  t.same(origins, ['http://192.0.2.10', 'http://192.0.2.10'])
})

test('dns: populated caches do not leak across later TTL policies', async (t) => {
  const positiveOrigins = []
  let positiveLookups = 0
  const positiveLookup = (hostname, options, callback) => {
    positiveLookups++
    callback(null, [{ address: `192.0.2.${positiveLookups}`, family: 4 }])
  }
  const positiveDispatch = makeDispatch(positiveOrigins)

  await request(positiveDispatch, { lookup: positiveLookup, ttl: 30_000, negativeTTL: 1000 })
  await request(positiveDispatch, { lookup: positiveLookup, ttl: 60_000, negativeTTL: 1000 })
  t.equal(positiveLookups, 2, 'a later positive policy performs its own lookup')
  t.same(positiveOrigins, ['http://192.0.2.1', 'http://192.0.2.2'])

  const negativeOrigins = []
  let negativeLookups = 0
  const recoveringLookup = (hostname, options, callback) => {
    negativeLookups++
    if (negativeLookups === 1) {
      callback(notFound(hostname))
    } else {
      callback(null, [{ address: '192.0.2.10', family: 4 }])
    }
  }
  const negativeDispatch = makeDispatch(negativeOrigins)

  await t.rejects(
    request(negativeDispatch, {
      lookup: recoveringLookup,
      ttl: 60_000,
      negativeTTL: 60_000,
    }),
    { code: 'ENOTFOUND' },
  )
  t.equal(
    await request(negativeDispatch, {
      lookup: recoveringLookup,
      ttl: 60_000,
      negativeTTL: 1000,
    }),
    200,
  )
  t.equal(negativeLookups, 2, 'a later negative policy is not poisoned by cached failure')
  t.same(negativeOrigins, ['http://192.0.2.10'])
})

test('dns: equal cache policies still deduplicate concurrent lookups', async (t) => {
  const origins = []
  const { calls, lookup } = pendingLookup()
  const dispatch = makeDispatch(origins)
  const dns = { lookup, ttl: 30_000, negativeTTL: 2000 }

  const first = request(dispatch, dns)
  const second = request(dispatch, { ...dns })

  t.equal(calls.length, 1, 'equal policy values share one lookup')
  calls[0].callback(null, [{ address: '192.0.2.20', family: 4 }])
  t.same(await Promise.all([first, second]), [200, 200])
  t.same(origins, ['http://192.0.2.20', 'http://192.0.2.20'])
})
