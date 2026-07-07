import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, Agent } from '../lib/index.js'

async function startServer(handler) {
  const server = createServer(handler ?? ((req, res) => res.end('hello')))
  server.listen(0)
  await once(server, 'listening')
  return server
}

// Explicit dispatcher: under tap the global dispatcher may have been replaced
// by Node's built-in undici (fetch shares the globalDispatcher symbol), which
// rejects this library's handlers with "invalid onRequestStart method". A
// fresh Agent per test also gives the dns interceptor a fresh cache (state is
// per composed dispatcher, see wrapDispatch's dispatcherCache).
function makeDispatcher(t) {
  const dispatcher = new Agent()
  t.teardown(() => dispatcher.close())
  return dispatcher
}

function makeWriter() {
  const docs = []
  return {
    docs,
    write(obj, op) {
      docs.push({ ...obj, op })
    },
  }
}

// ---------------------------------------------------------------------------
// first request → 'miss' doc with the logical (pre-rewrite) url
// ---------------------------------------------------------------------------

test('trace-dns: first request emits a miss doc', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))
  const port = server.address().port

  const writer = makeWriter()

  const { body, statusCode } = await request(`http://localhost:${port}`, {
    trace: writer,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()
  t.equal(statusCode, 200)

  const dnsDocs = writer.docs.filter((d) => d.op === 'undici:dns')
  t.equal(dnsDocs.length, 1)

  const [miss] = dnsDocs
  t.equal(miss.source, 'miss')
  t.equal(miss.url, `http://localhost:${port}/`, 'logical hostname, not the resolved IP')
  t.type(miss.durationMs, 'number')
  t.ok(miss.durationMs >= 0)
  t.equal(miss.durationMs, Math.round(miss.durationMs))
  t.type(miss.records, 'number')
  t.ok(miss.records >= 1)
  t.equal(miss.err, null)

  const start = writer.docs.find((d) => d.op === 'undici:request' && d.phase === 'start')
  t.equal(miss.id, start.id, 'attributed to the awaiting request')
})

// ---------------------------------------------------------------------------
// unresolvable host → 'miss' with err, immediate re-request → 'negative'
// ---------------------------------------------------------------------------

test('trace-dns: failed resolution emits miss with err, then negative fail-fast', async (t) => {
  const writer = makeWriter()
  const dispatcher = makeDispatcher(t)
  const origin = 'http://nxt-undici-does-not-exist.invalid'

  await t.rejects(request(origin, { trace: writer, retry: false, dispatcher }))

  let dnsDocs = writer.docs.filter((d) => d.op === 'undici:dns')
  t.equal(dnsDocs.length, 1)

  const [miss] = dnsDocs
  t.equal(miss.source, 'miss')
  t.equal(miss.url, `${origin}/`)
  t.equal(miss.records, null)
  t.match(miss.err, /^(ENOTFOUND|EAI_AGAIN)$/)
  t.type(miss.durationMs, 'number')
  t.ok(miss.durationMs >= 0)

  // Immediate second request: within the default negativeTTL (1s) the failure
  // is served from the negative cache before any lookup is issued.
  await t.rejects(request(origin, { trace: writer, retry: false, dispatcher }))

  dnsDocs = writer.docs.filter((d) => d.op === 'undici:dns')
  t.equal(dnsDocs.length, 2)

  const negative = dnsDocs[1]
  t.equal(negative.source, 'negative')
  t.equal(negative.url, `${origin}/`)
  t.equal(negative.durationMs, 0)
  t.equal(negative.records, null)
  t.equal(negative.err, miss.err)
})

// ---------------------------------------------------------------------------
// connection refused → 'undici:dns-evict'
// ---------------------------------------------------------------------------

test('trace-dns: connection error emits an evict doc', async (t) => {
  // Grab a free port, then close the server so connecting to it is refused.
  const server = await startServer()
  const port = server.address().port
  server.close()
  await once(server, 'close')

  const writer = makeWriter()

  await t.rejects(
    request(`http://localhost:${port}`, {
      trace: writer,
      retry: false,
      dispatcher: makeDispatcher(t),
    }),
  )

  const evicts = writer.docs.filter((d) => d.op === 'undici:dns-evict')
  t.equal(evicts.length, 1)

  const [evict] = evicts
  t.equal(evict.hostname, 'localhost')
  t.type(evict.address, 'string')
  t.ok(evict.address.length > 0)
  // The exact transport code can vary by platform/stack — assert it is one of
  // the codes the interceptor treats as a connection error.
  t.match(evict.err, /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/)
  t.type(evict.siblings, 'number')
  t.ok(evict.siblings >= 0)
})

// ---------------------------------------------------------------------------
// pre-emptive refresh → 'refresh' doc from the side-observer
// ---------------------------------------------------------------------------

test('trace-dns: pre-emptive refresh emits a refresh doc', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))
  const port = server.address().port

  const lookup = (hostname, opts, cb) => cb(null, [{ address: '127.0.0.1' }])

  // A ttl:1 request populates the cache with records expiring 1ms past the
  // coarse getFastNow() sample; a same-tick ttl:1000 request then hits the
  // cache AND sees the records past half their (new) TTL, firing the
  // fire-and-forget refresh. If a fastNow tick lands between the two requests
  // the second becomes a plain miss instead — retry with a fresh dispatcher
  // (fresh dns cache) up to a bounded number of attempts.
  let refresh = null
  let writer = null
  for (let attempt = 0; attempt < 5 && refresh == null; attempt++) {
    writer = makeWriter()
    const dispatcher = makeDispatcher(t)

    const first = await request(`http://localhost:${port}`, {
      trace: writer,
      dns: { ttl: 1, lookup },
      dispatcher,
    })
    await first.body.dump()

    const second = await request(`http://localhost:${port}`, {
      trace: writer,
      dns: { ttl: 1000, lookup },
      dispatcher,
    })
    await second.body.dump()

    // The side-observer settles on a microtask; poll briefly, bounded.
    const deadline = Date.now() + 1000
    while (refresh == null && Date.now() < deadline) {
      refresh = writer.docs.find((d) => d.op === 'undici:dns' && d.source === 'refresh')
      if (refresh == null) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  }

  t.ok(refresh, 'refresh doc emitted')
  t.equal(refresh.url, `http://localhost:${port}/`)
  t.equal(refresh.records, 1)
  t.equal(refresh.err, null)
  t.type(refresh.durationMs, 'number')
  t.ok(refresh.durationMs >= 0)

  const starts = writer.docs.filter((d) => d.op === 'undici:request' && d.phase === 'start')
  t.equal(refresh.id, starts[1].id, 'attributed to the request that triggered the refresh')
})

// ---------------------------------------------------------------------------
// deduped refresh → one doc per actual lookup, not per triggering request
// ---------------------------------------------------------------------------

test('trace-dns: concurrent refresh triggers emit one doc per lookup', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))
  const port = server.address().port

  // Same coarse-tick window trick as the refresh test above (bounded retries
  // absorb a fastNow tick slipping between requests). The refresh lookup
  // hangs until released so both triggering requests provably share ONE
  // in-flight resolution; a tick-slip miss also awaits it, so the release is
  // timer-driven rather than awaited behind the requests (no deadlock).
  let done = false
  for (let attempt = 0; attempt < 5 && !done; attempt++) {
    const writer = makeWriter()
    const dispatcher = makeDispatcher(t)

    let lookups = 0
    let release = null
    const lookup = (hostname, opts, cb) => {
      lookups++
      if (lookups === 1) {
        cb(null, [{ address: '127.0.0.1' }])
      } else {
        release = () => cb(null, [{ address: '127.0.0.1' }])
      }
    }

    const first = await request(`http://localhost:${port}`, {
      trace: writer,
      dns: { ttl: 1, lookup },
      dispatcher,
    })
    await first.body.dump()

    const pa = request(`http://localhost:${port}`, {
      trace: writer,
      dns: { ttl: 1000, lookup },
      dispatcher,
    })
    const pb = request(`http://localhost:${port}`, {
      trace: writer,
      dns: { ttl: 1000, lookup },
      dispatcher,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    release?.()
    for (const p of await Promise.all([pa, pb])) {
      await p.body.dump()
    }

    // Valid window: both follow-ups stayed on the cached-records path (one
    // miss doc total, from the first request) and exactly one refresh lookup
    // actually fired.
    const misses = writer.docs.filter((d) => d.op === 'undici:dns' && d.source === 'miss')
    if (misses.length !== 1 || lookups !== 2) {
      continue
    }

    // The side-observer settles on a microtask; poll briefly, bounded.
    const deadline = Date.now() + 1000
    let refreshes = []
    while (refreshes.length === 0 && Date.now() < deadline) {
      refreshes = writer.docs.filter((d) => d.op === 'undici:dns' && d.source === 'refresh')
      if (refreshes.length === 0) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    // Settle any stragglers before counting.
    await new Promise((resolve) => setTimeout(resolve, 10))
    refreshes = writer.docs.filter((d) => d.op === 'undici:dns' && d.source === 'refresh')

    t.equal(refreshes.length, 1, 'one refresh doc per deduped lookup')
    t.equal(refreshes[0].records, 1)
    t.equal(refreshes[0].err, null)
    done = true
  }

  t.ok(done, 'deterministic refresh window achieved within bounded attempts')
})
