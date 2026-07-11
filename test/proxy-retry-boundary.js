import { test } from 'tap'
import { request } from '../lib/index.js'

test('proxy sanitizes headers added by a retry callback on every attempt', async (t) => {
  const requests = []
  const dispatcher = (opts, handler) => {
    requests.push({ ...opts.headers })
    handler.onConnect(() => {})
    if (requests.length === 1) {
      handler.onHeaders(503, { 'content-length': '5' }, () => {})
      handler.onData(Buffer.from('retry'))
    } else {
      handler.onHeaders(200, { 'content-length': '2' }, () => {})
      handler.onData(Buffer.from('ok'))
    }
    handler.onComplete({})
    return true
  }

  const { body } = await request('http://127.0.0.1', {
    dispatch: dispatcher,
    dns: false,
    proxy: { name: 'edge' },
    retry: (err, retryCount, opts) => {
      t.equal(err.statusCode, 503)
      t.equal(retryCount, 0)

      opts.headers.connection = 'x-secret'
      opts.headers['x-secret'] = 'must-not-leak'
      opts.headers['proxy-authorization'] = 'must-not-leak'
      opts.headers['x-retry-attempt'] = '2'
      return true
    },
  })

  t.equal(await body.text(), 'ok')
  t.equal(requests.length, 2)
  t.notOk(requests[1].connection, 'Connection is stripped before the transport boundary')
  t.notOk(requests[1]['x-secret'], 'Connection-nominated fields are stripped from the retry')
  t.notOk(requests[1]['proxy-authorization'], 'proxy credentials are stripped from the retry')
  t.equal(requests[1]['x-retry-attempt'], '2', 'ordinary callback mutations are preserved')
  t.same(
    requests.map(({ via }) => via),
    ['HTTP/1.1 edge', 'HTTP/1.1 edge'],
    'Via is rebuilt once per attempt instead of accumulating',
  )
})

test('proxy leaves Trailer visible to retry before filtering the response', async (t) => {
  let attempts = 0
  let retryCalls = 0
  const dispatcher = (_opts, handler) => {
    attempts++
    handler.onConnect(() => {})

    if (attempts === 1) {
      handler.onHeaders(503, { trailer: 'x-checksum' }, () => {})
      handler.onData(Buffer.from('unavailable'))
      handler.onComplete({ 'x-checksum': 'ok' })
    } else {
      handler.onHeaders(200, {}, () => {})
      handler.onData(Buffer.from('unexpected retry'))
      handler.onComplete({})
    }
    return true
  }

  const { statusCode, headers, body } = await request('http://127.0.0.1', {
    dispatch: dispatcher,
    dns: false,
    proxy: {},
    error: false,
    verify: false,
    retry: () => {
      retryCalls++
      return true
    },
  })

  t.equal(statusCode, 503)
  t.equal(await body.text(), 'unavailable')
  t.equal(attempts, 1, 'a response that announces trailers is not retried')
  t.equal(retryCalls, 0, 'the retry strategy is bypassed for a trailer response')
  t.notOk(headers.trailer, 'the proxy still strips Trailer before exposing the response')
})
