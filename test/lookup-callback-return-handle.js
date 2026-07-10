import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function resolveOrigin(lookup) {
  let resolvedOrigin
  const dispatch = interceptors.lookup()((opts, handler) => {
    resolvedOrigin = opts.origin
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  })

  return new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://service.test',
        path: '/',
        method: 'GET',
        headers: {},
        lookup,
      },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          resolve(resolvedOrigin)
        },
        onError: reject,
      },
    )
  })
}

test('lookup: an incidental callback return handle is not used as the origin', async (t) => {
  const target = 'http://callback-result.test'
  const origin = await resolveOrigin((_value, _options, callback) => {
    return setImmediate(callback, null, target)
  })

  t.equal(origin, target)
})

test('lookup: the synchronous string return shorthand remains supported', async (t) => {
  const target = 'http://synchronous-result.test'

  t.equal(await resolveOrigin(() => target), target)
})

test('lookup: an async callback lookup may return Promise<void>', async (t) => {
  const target = 'http://async-callback-result.test'
  const origin = await resolveOrigin(async (_value, _options, callback) => {
    await Promise.resolve()
    callback(null, target)
  })

  t.equal(origin, target)
})
