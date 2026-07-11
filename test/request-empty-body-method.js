import { test } from 'tap'
import { request } from '../lib/index.js'

function recordingDispatcher(methods) {
  return {
    dispatch(opts, handler) {
      methods.push(opts.method)
      handler.onConnect(() => {})
      handler.onHeaders(200, { 'content-length': '0' }, () => {})
      handler.onComplete({})
    },
  }
}

test('request defaults to POST when an empty string body is present', async (t) => {
  const methods = []
  const dispatcher = recordingDispatcher(methods)

  const withBody = await request('http://example.test', { body: '', dispatcher, dns: false })
  await withBody.body.dump()
  const withoutBody = await request('http://example.test', { dispatcher, dns: false })
  await withoutBody.body.dump()

  t.strictSame(methods, ['POST', 'GET'])
})
