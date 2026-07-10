import { test } from 'tap'
import { setTimeout as sleep } from 'node:timers/promises'
import { interceptors } from '../lib/index.js'

function request(dispatch, lookup) {
  return new Promise((resolve, reject) => {
    let statusCode
    dispatch(
      {
        origin: 'http://shared-resolver.test:8080',
        path: '/',
        method: 'GET',
        headers: {},
        dns: { lookup, ttl: 60_000, negativeTTL: 60_000 },
      },
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

function resolver(address, onCall = () => {}) {
  return (hostname, options, callback) => {
    onCall()
    callback(null, [{ address, family: 4 }])
  }
}

test('dns: positive cache entries are isolated by custom resolver', async (t) => {
  const origins = []
  const dispatch = makeDispatch(origins)
  let callsA = 0
  let callsB = 0

  await request(
    dispatch,
    resolver('192.0.2.10', () => callsA++),
  )
  await request(
    dispatch,
    resolver('192.0.2.20', () => callsB++),
  )

  t.same(origins, ['http://192.0.2.10:8080', 'http://192.0.2.20:8080'])
  t.equal(callsA, 1)
  t.equal(callsB, 1, 'the second resolver was not bypassed by the first resolver cache')
})

test('dns: negative cache entries are isolated by custom resolver', async (t) => {
  const origins = []
  const dispatch = makeDispatch(origins)
  const failing = (hostname, options, callback) => {
    callback(Object.assign(new Error('private resolver miss'), { code: 'ENOTFOUND' }))
  }
  let successfulCalls = 0
  const successful = resolver('192.0.2.30', () => successfulCalls++)

  await t.rejects(request(dispatch, failing), { code: 'ENOTFOUND' })
  t.equal(await request(dispatch, successful), 200)

  t.same(origins, ['http://192.0.2.30:8080'])
  t.equal(successfulCalls, 1, 'one resolver failure did not poison another resolver')
})

test('dns: an invalid custom resolver reports an actionable error', async (t) => {
  const dispatch = makeDispatch([])

  await t.rejects(request(dispatch, 0), {
    name: 'TypeError',
    message: 'opts.dns.lookup must be a function',
  })
})

test('dns: in-flight lookups are isolated by custom resolver', async (t) => {
  const origins = []
  const dispatch = makeDispatch(origins)
  let releaseFirst
  const first = (hostname, options, callback) => {
    releaseFirst = () => callback(null, [{ address: '192.0.2.40', family: 4 }])
  }

  const firstRequest = request(dispatch, first)
  const secondRequest = request(dispatch, resolver('192.0.2.50'))
  const outcome = await Promise.race([
    secondRequest.then(() => 'resolved'),
    sleep(1000, undefined, { ref: false }).then(() => 'blocked'),
  ])

  releaseFirst()
  await Promise.all([firstRequest, secondRequest])

  t.equal(outcome, 'resolved', 'the second resolver did not join the first resolver lookup')
  t.same(origins, ['http://192.0.2.50:8080', 'http://192.0.2.40:8080'])
})
