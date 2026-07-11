import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const ORIGIN = 'http://ttl.test'

function run(dispatch, dns) {
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

function makeDispatch(origins = []) {
  return interceptors.dns()((opts, handler) => {
    origins.push(opts.origin)
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  })
}

function notFound(hostname) {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: 'ENOTFOUND',
    hostname,
  })
}

test('dns: rejects invalid TTL option values before lookup', async (t) => {
  const cases = [
    ['ttl', '1000', 'TypeError', 'must be a number'],
    ['negativeTTL', '1000', 'TypeError', 'must be a number'],
    ['ttl', null, 'TypeError', 'must be a number'],
    ['negativeTTL', null, 'TypeError', 'must be a number'],
    ['ttl', NaN, 'RangeError', 'must be a finite number greater than or equal to 0'],
    ['ttl', Infinity, 'RangeError', 'must be a finite number greater than or equal to 0'],
    ['ttl', -1, 'RangeError', 'must be a finite number greater than or equal to 0'],
    ['negativeTTL', NaN, 'RangeError', 'must be a finite number greater than or equal to 0'],
    ['negativeTTL', Infinity, 'RangeError', 'must be a finite number greater than or equal to 0'],
    ['negativeTTL', -1, 'RangeError', 'must be a finite number greater than or equal to 0'],
  ]
  let lookups = 0
  const lookup = () => lookups++
  const dispatch = makeDispatch()

  for (const [name, value, errorName, message] of cases) {
    await t.rejects(run(dispatch, { lookup, [name]: value }), {
      name: errorName,
      message: `opts.dns.${name} ${message}`,
    })
  }
  t.equal(lookups, 0, 'invalid cache policy never reaches the resolver')
})

test('dns: zero and sub-second TTLs use the real millisecond clock', async (t) => {
  const originalNow = Date.now
  let now = 10_000
  Date.now = () => now
  t.teardown(() => {
    Date.now = originalNow
  })

  let positiveLookups = 0
  const positiveOrigins = []
  const positiveLookup = (hostname, options, callback) => {
    positiveLookups++
    callback(null, [{ address: `192.0.2.${positiveLookups}`, family: 4 }])
  }
  const positiveDispatch = makeDispatch(positiveOrigins)
  const positiveDNS = { lookup: positiveLookup, ttl: 100 }

  await run(positiveDispatch, positiveDNS)
  now += 49
  await run(positiveDispatch, positiveDNS)
  t.equal(positiveLookups, 1, 'positive record remains cached before its half-life')

  now += 52
  await run(positiveDispatch, positiveDNS)
  t.equal(positiveLookups, 2, 'positive record expires after 100 real milliseconds')
  t.same(positiveOrigins, ['http://192.0.2.1', 'http://192.0.2.1', 'http://192.0.2.2'])

  let zeroLookups = 0
  const zeroLookup = (hostname, options, callback) => {
    zeroLookups++
    callback(null, [{ address: '192.0.2.10', family: 4 }])
  }
  const zeroDispatch = makeDispatch()
  await run(zeroDispatch, { lookup: zeroLookup, ttl: 0 })
  await run(zeroDispatch, { lookup: zeroLookup, ttl: 0 })
  t.equal(zeroLookups, 2, 'ttl: 0 does not cache sequential successful lookups')

  let negativeLookups = 0
  const recoveringLookup = (hostname, options, callback) => {
    negativeLookups++
    if (negativeLookups === 1) {
      callback(notFound(hostname))
    } else {
      callback(null, [{ address: '192.0.2.20', family: 4 }])
    }
  }
  const negativeDispatch = makeDispatch()
  const negativeDNS = { lookup: recoveringLookup, negativeTTL: 100 }

  now = 20_000
  await t.rejects(run(negativeDispatch, negativeDNS), { code: 'ENOTFOUND' })
  now += 49
  await t.rejects(run(negativeDispatch, negativeDNS), { code: 'ENOTFOUND' })
  t.equal(negativeLookups, 1, 'negative result remains cached before expiry')

  now += 52
  t.equal(await run(negativeDispatch, negativeDNS), 200)
  t.equal(negativeLookups, 2, 'negative result expires after 100 real milliseconds')

  let zeroNegativeLookups = 0
  const failingLookup = (hostname, options, callback) => {
    zeroNegativeLookups++
    callback(notFound(hostname))
  }
  const zeroNegativeDispatch = makeDispatch()
  const zeroNegativeDNS = { lookup: failingLookup, negativeTTL: 0 }
  await t.rejects(run(zeroNegativeDispatch, zeroNegativeDNS), { code: 'ENOTFOUND' })
  await t.rejects(run(zeroNegativeDispatch, zeroNegativeDNS), { code: 'ENOTFOUND' })
  t.equal(zeroNegativeLookups, 2, 'negativeTTL: 0 does not cache sequential failures')
})
