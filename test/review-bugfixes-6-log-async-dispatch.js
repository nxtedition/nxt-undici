import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const kGlobalArray = Symbol.for('@nxtedition/nxt-undici#globalArray')

test('log: an asynchronous dispatch rejection finalizes the in-flight handler', async (t) => {
  const failure = new Error('async dispatch failed')
  const errors = []
  const logger = {
    child() {
      return this
    },
    debug() {},
    warn() {},
    error(...args) {
      errors.push(args)
    },
  }
  const before = globalThis[kGlobalArray]?.length ?? 0
  const dispatch = interceptors.log()(() => Promise.reject(failure))
  let onErrorCalls = 0

  const caught = await dispatch(
    { origin: 'http://example.test', path: '/', method: 'GET', logger },
    {
      onConnect() {},
      onHeaders() {},
      onData() {},
      onComplete() {},
      onError() {
        onErrorCalls++
      },
    },
  ).catch((err) => err)

  t.equal(caught, failure, 'the original rejection remains observable by an outer layer')
  t.equal(globalThis[kGlobalArray]?.length ?? 0, before, 'no in-flight registry entry leaks')
  t.equal(onErrorCalls, 0, 'the log layer does not double-deliver the outer error path')
  t.equal(errors.length, 1, 'the rejection receives one terminal failure log')
  t.not(errors[0][0].err, failure, 'the logger receives an isolated error snapshot')
  t.equal(errors[0][0].err.message, failure.message, 'the snapshot keeps useful diagnostics')
})
