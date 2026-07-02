// Regression tests for the response-retry interceptor mishandling a
// duplicated (array-valued) etag response header. A misconfigured proxy that
// duplicates ETag made `this.#etag.startsWith('W/')` throw a TypeError out of
// onHeaders, aborting a perfectly good response. A non-string etag simply
// means "no resume-etag available" — the response must still succeed.
import { createServer } from 'node:http'
import { test } from 'tap'
import { request } from '../lib/index.js'

test('duplicated (array) etag header on 200 does not abort the response', (t) => {
  t.plan(2)

  const server = createServer((req, res) => {
    res.setHeader('etag', ['"abc"', '"abc"'])
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`)
    t.equal(statusCode, 200)
    t.equal(await body.text(), 'asd')
  })
})

test('duplicated (array) etag header on 206 does not abort the response', (t) => {
  t.plan(3)

  const server = createServer((req, res) => {
    t.equal(req.headers.range, 'bytes=0-2')
    res.statusCode = 206
    res.setHeader('content-range', 'bytes 0-2/6')
    res.setHeader('etag', ['"abc"', '"abc"'])
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body, statusCode } = await request(`http://0.0.0.0:${server.address().port}`, {
      headers: { range: 'bytes=0-2' },
    })
    t.equal(statusCode, 206)
    t.equal(await body.text(), 'asd')
  })
})
