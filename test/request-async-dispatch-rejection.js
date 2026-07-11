import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'tap'
import { request as publicRequest } from '../lib/index.js'
import { request as coreRequest } from '../lib/request.js'

test('request handles a dispatch function that returns a rejected promise', async (t) => {
  const expected = new Error('async dispatch failure')
  const signal = new EventEmitter()
  const body = new Readable({ read() {} })
  const dispatch = async () => {
    await Promise.resolve()
    throw expected
  }

  await t.rejects(coreRequest(dispatch, 'http://example.test', { body, signal }), expected)
  t.equal(body.destroyed, true)
  t.equal(signal.listenerCount('abort'), 0)
})

test('request errors an already-created response body on async dispatch rejection', async (t) => {
  const expected = new Error('late async dispatch failure')
  let rejectDispatch
  const dispatch = (_opts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    return new Promise((_resolve, reject) => {
      rejectDispatch = reject
    })
  }

  const { body } = await coreRequest(dispatch, 'http://example.test')
  const text = body.text()
  rejectDispatch(expected)

  await t.rejects(text, expected)
})

test('public request handles a DispatchFn promise rejection', async (t) => {
  const expected = new Error('public async dispatch failure')
  const dispatch = async () => {
    await Promise.resolve()
    throw expected
  }

  await t.rejects(
    publicRequest('http://127.0.0.1', { dispatch, dns: false, retry: false }),
    expected,
  )
})
