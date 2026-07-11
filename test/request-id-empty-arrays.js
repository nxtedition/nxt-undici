import { test } from 'tap'
import requestId from '../lib/interceptor/request-id.js'

function capture(opts) {
  let captured
  requestId()((value) => {
    captured = value
  })(opts, {})
  return captured
}

test('request-id treats an empty repeated header as absent', (t) => {
  const opts = capture({ headers: { 'request-id': [] } })

  t.match(opts.id, /^req-/)
  t.equal(opts.headers['request-id'], opts.id)
  t.notMatch(opts.id, /^,/)
  t.end()
})

test('request-id removes empty values from a repeated parent chain', (t) => {
  const opts = capture({ headers: { 'request-id': ['', 'parent', ''] } })

  t.match(opts.id, /^parent,req-/)
  t.equal(opts.headers['request-id'], opts.id)
  t.end()
})

test('request-id lets an empty runtime opts.id array fall back to the header', (t) => {
  const opts = capture({ id: [], headers: { 'request-id': 'parent' } })

  t.match(opts.id, /^parent,req-/)
  t.end()
})
