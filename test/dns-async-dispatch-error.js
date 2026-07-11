import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function request(dispatch, opts = {}) {
  return new Promise((resolve, reject) => {
    const errors = []
    const returned = dispatch(
      {
        origin: 'http://async-dispatch.test',
        path: '/',
        method: 'GET',
        headers: {},
        dns: {
          lookup(hostname, options, callback) {
            callback(null, [{ address: '127.0.0.1', family: 4 }])
          },
        },
        ...opts,
      },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          resolve({ errors })
        },
        onError(err) {
          errors.push(err)
          resolve({ errors })
        },
      },
    )
    Promise.resolve(returned).catch(reject)
  })
}

test('dns: an asynchronous downstream rejection is delivered via onError', async (t) => {
  const failure = new Error('asynchronous dispatch failure')
  const dispatch = interceptors.dns()(async () => {
    await Promise.resolve()
    throw failure
  })

  const { errors } = await request(dispatch)

  t.same(errors, [failure])
})

test('dns: a downstream onError followed by a synchronous throw stays once-only', async (t) => {
  const reported = new Error('reported failure')
  const escaped = new Error('escaped failure')
  const dispatch = interceptors.dns()((opts, handler) => {
    handler.onError(reported)
    throw escaped
  })

  const { errors } = await request(dispatch)

  t.same(errors, [reported])
})

test('dns: an asynchronous rejection is handled on the IP bypass path', async (t) => {
  const failure = new Error('IP dispatch failure')
  const dispatch = interceptors.dns()(async () => {
    throw failure
  })

  const { errors } = await request(dispatch, { origin: 'http://127.0.0.1' })

  t.same(errors, [failure])
})
