import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const ORIGIN = 'http://abort-accounting.test'

function makeWriter() {
  const docs = []
  return {
    docs,
    write(obj, op) {
      docs.push({ ...obj, op })
    },
  }
}

function request(dispatch, dns, { abort = false, reason } = {}) {
  return new Promise((resolve) => {
    let statusCode
    dispatch(
      { origin: ORIGIN, path: '/', method: 'GET', headers: {}, dns },
      {
        onConnect(abortRequest) {
          if (abort) {
            abortRequest(reason)
          }
        },
        onHeaders(value) {
          statusCode = value
          return true
        },
        onData() {},
        onComplete() {
          resolve({ type: 'complete', value: statusCode })
        },
        onError(err) {
          resolve({ type: 'error', value: err })
        },
      },
    )
  })
}

async function verifyReason(t, reason, label) {
  const origins = []
  let lookups = 0
  const lookup = (hostname, options, callback) => {
    lookups++
    callback(null, [
      { address: '192.0.2.1', family: 4 },
      { address: '192.0.2.2', family: 4 },
    ])
  }
  const writer = makeWriter()
  const dns = { lookup, ttl: 60_000 }
  const dispatch = interceptors.dns()((opts, handler) => {
    origins.push(opts.origin)
    let aborted = false
    handler.onConnect((value) => {
      aborted = true
      handler.onError(value)
    })
    if (!aborted) {
      handler.onHeaders(200, {}, () => {})
      handler.onComplete([])
    }
  })

  const aborted = await request(dispatch, { ...dns, trace: writer }, { abort: true, reason })
  t.equal(aborted.type, 'error', `${label}: abort reaches the terminal handler`)
  t.equal(aborted.value, reason, `${label}: reason identity is preserved`)

  t.same(await request(dispatch, dns), { type: 'complete', value: 200 })
  t.same(await request(dispatch, dns), { type: 'complete', value: 200 })

  t.same(
    origins,
    ['http://192.0.2.1', 'http://192.0.2.2', 'http://192.0.2.1'],
    `${label}: aborted address remains healthy in load balancing`,
  )
  t.equal(lookups, 1, `${label}: client abort did not evict and re-resolve the address`)
  t.notOk(
    writer.docs.some((doc) => doc.op === 'undici:dns-evict'),
    `${label}: client abort emitted no eviction trace`,
  )
}

test('dns: custom client abort errors do not penalize or evict the selected address', async (t) => {
  await verifyReason(t, new Error('cancelled by caller'), 'ordinary Error')
  await verifyReason(
    t,
    Object.assign(new Error('cancelled by caller'), { code: 'ECONNRESET' }),
    'connection-shaped Error',
  )
})

test('dns: falsy client abort reasons do not penalize the selected address', async (t) => {
  for (const [label, reason] of [
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
  ]) {
    await verifyReason(t, reason, label)
  }
})

test('dns: client-abort provenance does not leak across reconnects', async (t) => {
  const origins = []
  let lookups = 0
  const lookup = (hostname, options, callback) => {
    lookups++
    callback(null, [
      { address: '192.0.2.1', family: 4 },
      { address: '192.0.2.2', family: 4 },
    ])
  }
  let firstRequest = true
  const dispatch = interceptors.dns()((opts, handler) => {
    origins.push(opts.origin)
    if (firstRequest) {
      firstRequest = false
      handler.onConnect(() => {})
      handler.onConnect(() => {})
      handler.onError(new Error('second attempt transport failure'))
    } else {
      handler.onConnect(() => {})
      handler.onHeaders(200, {}, () => {})
      handler.onComplete([])
    }
  })
  const dns = { lookup, ttl: 60_000 }

  let connections = 0
  const first = await new Promise((resolve) => {
    dispatch(
      { origin: ORIGIN, path: '/', method: 'GET', headers: {}, dns },
      {
        onConnect(abort) {
          connections++
          if (connections === 1) {
            abort(new Error('first attempt cancelled'))
          }
        },
        onError: resolve,
      },
    )
  })
  t.match(first, { message: 'second attempt transport failure' })

  await request(dispatch, dns)
  await request(dispatch, dns)
  t.same(
    origins,
    ['http://192.0.2.1', 'http://192.0.2.2', 'http://192.0.2.2'],
    'the later transport failure still penalizes the reconnected address',
  )
  t.equal(lookups, 1)
})
