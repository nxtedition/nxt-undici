import t from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request } from '../lib/index.js'

// Regression: redirect.js resolved a relative Location against
// `new URL(opts.path, opts.origin)`. When the request path is
// protocol-relative (starts with `//`, reachable via a public request URL such
// as `http://good//evil/x`), WHATWG URL treats the leading `//evil` as the
// authority and discards the good origin's host. A relative redirect from the
// good origin would then be re-dispatched to the attacker-controlled host —
// an SSRF / request-misrouting pivot. The fix builds the base by concatenating
// origin + path (utils.buildURL), keeping the origin authoritative.
t.test('protocol-relative request path: relative Location stays on the good origin', async (t) => {
  // "evil" host — the buggy code would re-dispatch the redirect here.
  let evilHits = 0
  const evil = createServer((req, res) => {
    evilHits += 1
    res.setHeader('Connection', 'close')
    res.statusCode = 200
    res.end('EVIL')
  })
  evil.listen(0, '127.0.0.1')
  await once(evil, 'listening')
  t.teardown(() => evil.close())
  const evilPort = evil.address().port

  // "good" origin — the only host we ever want to talk to.
  let goodRequests = 0
  let secondPath = null
  const good = createServer((req, res) => {
    goodRequests += 1
    res.setHeader('Connection', 'close')
    if (goodRequests === 1) {
      // First hop: reply with a *relative* Location.
      res.statusCode = 301
      res.setHeader('Location', 'b')
      res.end('')
    } else {
      secondPath = req.url
      res.statusCode = 200
      res.end(`GOOD ${req.url}`)
    }
  })
  good.listen(0, '127.0.0.1')
  await once(good, 'listening')
  t.teardown(() => good.close())
  const goodPort = good.address().port

  // Public request URL whose path is protocol-relative and embeds the evil
  // host: parseURL yields origin=http://127.0.0.1:<goodPort>,
  // path=//127.0.0.1:<evilPort>/x.
  const { statusCode, body } = await request(
    `http://127.0.0.1:${goodPort}//127.0.0.1:${evilPort}/x`,
    { follow: 5 },
  )
  const text = await body.text()

  t.equal(statusCode, 200, 'final response comes back OK')
  t.equal(evilHits, 0, 'must never hit the protocol-relative (evil) host')
  t.equal(goodRequests, 2, 'both hops stay on the good origin')
  // Relative `b` resolves against the good host, in the directory of the
  // original protocol-relative path — NOT against the evil host.
  t.equal(secondPath, `//127.0.0.1:${evilPort}/b`)
  t.equal(text, `GOOD //127.0.0.1:${evilPort}/b`)
})
