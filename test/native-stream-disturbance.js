import { Readable } from 'node:stream'
import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function destroyedUnreadBody() {
  const body = new Readable({ read() {} })
  body.destroy()
  return body
}

test('redirect does not replay a destroyed unread Readable', (t) => {
  const body = destroyedUnreadBody()
  let dispatches = 0

  const dispatch = compose((opts, handler) => {
    dispatches++
    handler.onConnect(() => {})
    handler.onHeaders(307, { location: '/next' }, () => {})
    handler.onComplete(null)
    return true
  }, interceptors.redirect())

  t.equal(body.readableDidRead, false, 'body was cancelled before any data was read')
  t.throws(
    () =>
      dispatch(
        {
          body,
          follow: 1,
          method: 'POST',
          origin: 'http://example.test',
          path: '/',
        },
        {
          onConnect() {},
          onError(err) {
            throw err
          },
        },
      ),
    /Disturbed request cannot be redirected/,
  )
  t.equal(dispatches, 1, 'the cancelled body is not dispatched to the redirect target')
  t.end()
})

test('retry does not replay a destroyed unread Readable', async (t) => {
  const body = destroyedUnreadBody()
  const networkError = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
  let dispatches = 0
  let retryCalls = 0

  const dispatch = compose((opts, handler) => {
    dispatches++
    handler.onConnect(() => {})
    handler.onError(networkError)
    return true
  }, interceptors.responseRetry())

  const err = await new Promise((resolve, reject) => {
    dispatch(
      {
        body,
        method: 'POST',
        origin: 'http://example.test',
        path: '/',
        retry() {
          retryCalls++
          return retryCalls === 1
        },
      },
      {
        onConnect() {},
        onComplete() {
          reject(new Error('unexpected completion'))
        },
        onError: resolve,
      },
    )
  })

  t.equal(body.readableDidRead, false, 'body was cancelled before any data was read')
  t.equal(err, networkError)
  t.equal(dispatches, 1, 'the cancelled body is not dispatched a second time')
  t.equal(retryCalls, 0, 'the retry strategy is skipped for a disturbed body')
})
