import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function handler(onError) {
  return {
    onConnect() {},
    onHeaders() {
      return true
    },
    onData() {},
    onComplete() {},
    onError,
  }
}

const opts = {
  origin: 'http://service.test',
  path: '/',
  method: 'GET',
  headers: {},
  lookup(origin, options, callback) {
    callback(null, 'http://resolved.test')
  },
}

test('lookup: an asynchronous downstream rejection is delivered via onError', async (t) => {
  const failure = new Error('asynchronous dispatch failure')
  const dispatch = interceptors.lookup()(async () => {
    await Promise.resolve()
    throw failure
  })

  const errors = []
  await dispatch(
    opts,
    handler((err) => errors.push(err)),
  )

  t.same(errors, [failure])
})

test('lookup: a downstream onError followed by rejection stays once-only', async (t) => {
  const reported = new Error('reported failure')
  const escaped = new Error('escaped failure')
  const dispatch = interceptors.lookup()(async (opts, wrapped) => {
    wrapped.onError(reported)
    throw escaped
  })

  const errors = []
  await dispatch(
    opts,
    handler((err) => errors.push(err)),
  )

  t.same(errors, [reported])
})
