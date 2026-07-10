import { test } from 'tap'
import { setTimeout as sleep } from 'node:timers/promises'
import { interceptors } from '../lib/index.js'

function request(dispatch, dns) {
  return new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://resolver-errors.test',
        path: '/',
        method: 'GET',
        headers: {},
        dns,
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

function successfulDispatch(opts, handler) {
  handler.onConnect(() => {})
  handler.onHeaders(200, {}, () => {})
  handler.onComplete([])
}

test('dns: a synchronously throwing resolver is cleared and can recover', async (t) => {
  let calls = 0
  const lookup = (hostname, options, callback) => {
    calls++
    if (calls === 1) {
      throw new Error('resolver exploded')
    }
    callback(null, [{ address: '127.0.0.1', family: 4 }])
  }

  const dispatch = interceptors.dns()(successfulDispatch)
  const dns = { lookup, negativeTTL: 0 }

  await t.rejects(request(dispatch, dns), /resolver exploded/)

  // getFastNow() advances once per second. Wait for a tick so the zero-length
  // negative-cache entry is expired before checking that resolution retries.
  await sleep(1500)

  t.equal(await request(dispatch, dns), 200)
  t.equal(calls, 2, 'the rejected in-flight promise was not retained forever')
})

test('dns: a synchronous callback-processing throw rejects and does not stick', async (t) => {
  let calls = 0
  const lookup = (hostname, options, callback) => {
    calls++
    callback(null, calls === 1 ? null : [{ address: '127.0.0.1', family: 4 }])
  }
  const dispatch = interceptors.dns()(successfulDispatch)

  await t.rejects(
    request(dispatch, { lookup }),
    /map|invalid DNS lookup result/,
    'malformed callback data rejects without retaining the settled lookup',
  )
  t.equal(await request(dispatch, { lookup }), 200)
  t.equal(calls, 2, 'the callback-side exception was not turned into a pending promise')
})
