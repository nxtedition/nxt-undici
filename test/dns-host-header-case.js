import { test } from 'tap'
import { interceptors } from '../lib/index.js'
import { createNormalizedHeaders } from '../lib/utils.js'

function resolvedHeaders(headers) {
  let captured
  const dispatch = interceptors.dns()((opts, handler) => {
    captured = opts.headers
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete([])
  })

  return new Promise((resolve, reject) => {
    dispatch(
      {
        origin: 'http://host-case.test:8080',
        path: '/',
        method: 'GET',
        headers,
        dns: {
          lookup(hostname, options, callback) {
            callback(null, [{ address: '127.0.0.1', family: 4 }])
          },
        },
      },
      {
        onConnect() {},
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          resolve(captured)
        },
        onError: reject,
      },
    )
  })
}

test('dns: a mixed-case Host override is preserved without duplication', async (t) => {
  const headers = await resolvedHeaders({ Host: 'virtual.example' })

  t.same(headers, { host: 'virtual.example' })
})

test('dns: an untrusted normalized-looking object is copied', async (t) => {
  const input = { host: 'virtual.example', 'x-test': 'value' }
  const headers = await resolvedHeaders(input)

  t.not(headers, input)
  t.same(headers, input)
})

test('dns: an internally normalized snapshot takes the branded fast path', async (t) => {
  const input = createNormalizedHeaders({ host: 'virtual.example', 'x-test': 'value' })
  const headers = await resolvedHeaders(input)

  t.equal(headers, input)
})

test('dns: case-variant duplicate Host fields fall back to the logical origin', async (t) => {
  const headers = await resolvedHeaders({ Host: 'one.example', host: 'two.example' })

  t.same(headers, { host: 'host-case.test:8080' })
})
