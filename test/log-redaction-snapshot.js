import { Writable } from 'node:stream'
import pino from 'pino'
import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function captureLogger() {
  let output = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk
      callback()
    },
  })

  return {
    logger: pino({ level: 'debug', base: null, timestamp: false }, stream),
    records() {
      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
    output() {
      return output
    },
  }
}

test('log snapshots request and response headers before later wire mutations', (t) => {
  const capture = captureLogger()
  const requestHeaders = {
    'x-request-safe': 'visible',
    'x-request-values': ['initial-request-value'],
  }
  const responseHeaders = {
    'x-response-safe': 'visible',
    'x-response-values': ['initial-response-value'],
  }
  let dispatchedHeaders

  const dispatch = interceptors.log()((opts, handler) => {
    dispatchedHeaders = opts.headers
    handler.onConnect(() => {})

    opts.headers.authorization = 'Bearer later-request-secret'
    opts.headers['x-request-values'].push('later-request-array-value')

    handler.onHeaders(500, responseHeaders, () => {})
    responseHeaders['set-cookie'] = 'session=later-response-secret'
    responseHeaders['x-response-values'].push('later-response-array-value')
    handler.onComplete([])
  })

  dispatch(
    {
      origin: 'http://example.test',
      path: '/',
      method: 'GET',
      headers: requestHeaders,
      logger: capture.logger,
    },
    {},
  )

  const completed = capture.records().find((record) => record.msg === 'upstream request completed')

  t.equal(dispatchedHeaders, requestHeaders, 'the wire request keeps its original header object')
  t.equal(requestHeaders.authorization, 'Bearer later-request-secret', 'wire mutation still lands')
  t.equal(
    responseHeaders['set-cookie'],
    'session=later-response-secret',
    'response object mutation still lands',
  )
  t.strictSame(completed.ureq.headers, {
    'x-request-safe': 'visible',
    'x-request-values': ['initial-request-value'],
  })
  t.strictSame(completed.ures.headers, {
    'x-response-safe': 'visible',
    'x-response-values': ['initial-response-value'],
  })
  t.notMatch(capture.output(), /later-request-secret/)
  t.notMatch(capture.output(), /later-response-secret/)
  t.notMatch(capture.output(), /later-request-array-value/)
  t.notMatch(capture.output(), /later-response-array-value/)
  t.end()
})
