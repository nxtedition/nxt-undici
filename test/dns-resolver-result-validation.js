import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function request(dispatch, lookup) {
  return new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://resolver-results.test',
        path: '/',
        method: 'GET',
        headers: {},
        dns: { lookup, negativeTTL: 60_000 },
      },
      {
        onConnect() {},
        onHeaders(statusCode) {
          resolve(statusCode)
          return true
        },
        onData() {},
        onComplete() {},
        onError: reject,
      },
    )
  })
}

test('dns: malformed asynchronous resolver results reject instead of escaping callback', async (t) => {
  const lookup = (hostname, options, callback) => {
    setImmediate(callback, null, null)
  }
  const dispatch = interceptors.dns()(() => {
    t.fail('transport must not receive a malformed resolver result')
  })

  const err = await request(dispatch, lookup).then(
    () => null,
    (err) => err,
  )

  t.equal(err?.message, 'invalid DNS lookup result: expected an array of records')
  t.type(err?.cause, TypeError)
})

test('dns: a non-IP resolver record is rejected before dispatch', async (t) => {
  const lookup = (hostname, options, callback) => {
    setImmediate(callback, null, [{ address: 'fallback-dns.test', family: 4 }])
  }
  const dispatch = interceptors.dns()(() => {
    t.fail('an invalid address must not be passed to the transport as a hostname')
  })

  const err = await request(dispatch, lookup).then(
    () => null,
    (err) => err,
  )

  t.equal(err?.message, 'invalid DNS lookup result: expected IP address records')
  t.type(err?.cause, TypeError)
})

test('dns: malformed resolver output is not negative-cached', async (t) => {
  let calls = 0
  const lookup = (hostname, options, callback) => {
    calls++
    setImmediate(callback, null, calls === 1 ? null : [{ address: '127.0.0.1', family: 4 }])
  }
  const dispatch = interceptors.dns()((opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  })

  await t.rejects(request(dispatch, lookup), /invalid DNS lookup result/)
  t.equal(await request(dispatch, lookup), 200, 'a corrected result is accepted immediately')
  t.equal(calls, 2, 'validation failures do not create a negative-cache entry')
})

test('dns: an empty successful result is negative-cached', async (t) => {
  let calls = 0
  const lookup = (hostname, options, callback) => {
    calls++
    setImmediate(callback, null, [])
  }
  const dispatch = interceptors.dns()(() => {
    t.fail('transport must not receive an empty resolver result')
  })

  const expected = {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname: 'resolver-results.test',
  }
  await t.rejects(request(dispatch, lookup), expected)
  await t.rejects(request(dispatch, lookup), expected)
  t.equal(calls, 1, 'the empty result does not cause a hot lookup loop')
})
