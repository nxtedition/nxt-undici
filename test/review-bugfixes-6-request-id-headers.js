import { test } from 'tap'
import { interceptors } from '../lib/index.js'

function captureRequest(headers) {
  let captured
  const dispatch = interceptors.requestId()((opts) => {
    captured = opts
  })

  dispatch({ origin: 'http://example.test', path: '/', headers }, {})
  return captured
}

test('request-id: a mixed-case parent header is preserved in the chain', (t) => {
  const captured = captureRequest({ 'Request-ID': 'parent-id', 'X-Test': 'value' })

  t.match(captured.id, /^parent-id,req-/)
  t.equal(captured.headers['request-id'], captured.id)
  t.equal(captured.headers['x-test'], 'value')
  t.notOk('Request-ID' in captured.headers, 'does not leave a duplicate mixed-case field')
  t.end()
})

test('request-id: a flat-array parent header is preserved in the chain', (t) => {
  const captured = captureRequest(['Request-ID', 'parent-id', 'X-Test', 'value'])

  t.match(captured.id, /^parent-id,req-/)
  t.equal(captured.headers['request-id'], captured.id)
  t.equal(captured.headers['x-test'], 'value')
  t.notOk('0' in captured.headers, 'does not spread array indexes into the header object')
  t.end()
})
