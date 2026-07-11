import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function responseWithVia(via, name) {
  return new Promise((resolve, reject) => {
    const dispatch = compose((opts, handler) => {
      handler.onConnect(() => {})
      try {
        handler.onHeaders(200, { via }, () => {})
        handler.onComplete([])
      } catch (err) {
        handler.onError(err)
      }
    }, interceptors.proxy())

    let received
    dispatch(
      {
        origin: 'http://upstream.test',
        path: '/',
        method: 'GET',
        headers: {},
        proxy: { name },
      },
      {
        onConnect() {},
        onHeaders(statusCode, headers) {
          received = headers
          return true
        },
        onData() {},
        onComplete() {
          resolve(received)
        },
        onError: reject,
      },
    )
  })
}

test('proxy: a Via received-by lookalike inside a comment is not a loop', async (t) => {
  const headers = await responseWithVia('1.1 upstream (outer (note, 1.1 edge , tail))', 'edge')

  t.equal(headers.via, '1.1 upstream (outer (note, 1.1 edge , tail)), HTTP/1.1 edge')
})

test('proxy: quoted-pair parentheses keep a Via comma inside its comment', async (t) => {
  const headers = await responseWithVia('1.1 upstream (note\\) still comment, 1.1 edge)', 'edge')

  t.equal(headers.via, '1.1 upstream (note\\) still comment, 1.1 edge), HTTP/1.1 edge')
})

test('proxy: a genuine Via loop is found before a comma-bearing comment', async (t) => {
  await t.rejects(responseWithVia('1.1 edge (note, other proxy)', 'edge'), { statusCode: 508 })
})
