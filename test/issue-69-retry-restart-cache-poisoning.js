import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'tap'
import undici from '@nxtedition/undici'
import { request } from '../lib/index.js'

// Regression test for issue #69.
//
// When a cacheable 200 delivers its headers but the connection dies before any
// body byte, responseRetry resumes with `range: bytes=0-`. Because headers were
// already forwarded, onConnect is not re-driven, so the CacheHandler keeps the
// entry it built from attempt 1's headers (the cache interceptor sits OUTSIDE
// responseRetry in the default chain, so it observes the retry layer's spliced
// output). If the pos=0 restart branch then accepted a full 200 from attempt 2
// without a validator, the cache would persist attempt 1's headers,
// cache-control/TTL, Date and validators paired with attempt 2's BODY — and
// replay that splice to every client for attempt 1's freshness lifetime,
// ignoring attempt 2's own (here: no-store) directive.
//
// The fix declines the unvalidated restart, so the poisoned entry is never
// stored: the first request fails and a later request fetches the origin fresh.
//
// request() wraps the dispatcher with the full default interceptor chain
// (cache + responseRetry included), so `cache: true` + `retry` exercise exactly
// the production ordering — no manual compose() needed.

test('issue #69: unvalidated pos=0 full-200 restart does not poison the cache', async (t) => {
  t.plan(4)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      // Cacheable, long-lived, NO strong etag — headers only, then die before
      // any body byte so the resume starts at pos 0 with no validator to send.
      res.writeHead(200, { 'content-length': '5', 'cache-control': 'max-age=3600' })
      res.flushHeaders()
      setTimeout(() => res.destroy(), 50)
    } else if (attempts === 2) {
      // The resume: a server that ignored Range and restarted the full 200 with
      // a DIFFERENT body and a no-store directive. Accepting this would splice
      // "WORLD" onto attempt 1's max-age=3600 headers and cache it for an hour.
      res.writeHead(200, { 'content-length': '5', 'cache-control': 'no-store' })
      res.end('WORLD')
    } else {
      // Reached only if the poisoned entry was NOT stored: a fresh origin fetch.
      res.writeHead(200, { 'content-length': '5', 'cache-control': 'max-age=3600' })
      res.end('hello')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')

  const url = `http://0.0.0.0:${server.address().port}`
  const dispatcher = new undici.Agent()
  t.teardown(() => dispatcher.close())

  // First request: the unvalidated restart must be declined, not delivered.
  const first = await request(url, { dispatcher, cache: true, retry: () => true })
  await t.rejects(
    first.body.text(),
    /Response retry failed/,
    'the unvalidated restart is declined instead of spliced',
  )

  // Second request: if the cache had been poisoned it would serve "WORLD" with
  // max-age=3600 without hitting the origin. Instead it must miss and fetch the
  // origin fresh.
  const second = await request(url, { dispatcher, cache: true, retry: () => true })
  const text = await second.body.text()

  t.equal(text, 'hello', 'second request is served the fresh origin body, not the spliced one')
  t.not(text, 'WORLD', 'attempt 2 body was never cached against attempt 1 headers')
  t.equal(attempts, 3, 'initial + declined resume + a fresh origin fetch (no cache hit)')
})

test('issue #69: malformed etag cannot validate a restart or poison the cache', async (t) => {
  t.plan(5)

  let attempts = 0
  const server = createServer((req, res) => {
    attempts++
    if (attempts === 1) {
      // An unquoted value is not an entity-tag. It must not be retained as a
      // strong validator or copied into the resume's If-Match request.
      res.writeHead(200, {
        'content-length': '5',
        'cache-control': 'max-age=3600',
        etag: 'bogus',
      })
      res.flushHeaders()
      setTimeout(() => res.destroy(), 50)
    } else if (attempts === 2) {
      t.notOk('if-match' in req.headers, 'malformed etag is not sent as If-Match')
      // Echoing the same malformed text must not satisfy the splice gate. If
      // accepted, WORLD would inherit attempt 1's one-hour freshness despite
      // this response explicitly being no-store.
      res.writeHead(200, {
        'content-length': '5',
        'cache-control': 'no-store',
        etag: 'bogus',
      })
      res.end('WORLD')
    } else {
      res.writeHead(200, { 'content-length': '5', 'cache-control': 'max-age=3600' })
      res.end('hello')
    }
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await once(server, 'listening')

  const url = `http://0.0.0.0:${server.address().port}`
  const dispatcher = new undici.Agent()
  t.teardown(() => dispatcher.close())

  const first = await request(url, { dispatcher, cache: true, retry: () => true })
  await t.rejects(
    first.body.text(),
    /Response retry failed/,
    'the malformed-etag restart is declined instead of spliced',
  )

  const second = await request(url, { dispatcher, cache: true, retry: () => true })
  const text = await second.body.text()
  t.equal(text, 'hello', 'later request fetches the fresh origin body')
  t.not(text, 'WORLD', 'the restarted body was not stored with attempt 1 headers')
  t.equal(attempts, 3, 'initial + declined resume + fresh origin fetch')
})
