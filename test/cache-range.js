/* eslint-disable */
// Dedicated tests for caching of range requests (nxtedition/nxt-undici#56).
//
// Current design (lib/interceptor/cache.js + lib/sqlite-cache-store.js):
// - 206 + valid single Content-Range is stored with its byte window
//   (start inclusive, end exclusive); windows for the same URL coexist.
// - A request Range is served from cache only on an EXACT window match
//   (`bytes=S-E` against a stored [S, E+1) entry, or a closed full-body range
//   against a stored 200). There is no slicing of wider entries and no
//   suffix/multi-range parsing — those go to the origin.
// - A request without Range never sees a stored 206; a stale 206 is never
//   conditionally revalidated (refetched instead); If-Range bypasses entirely.
// These tests lock in the safe half of that contract: no wrong-window serves,
// no 206 to a non-range request, no partial bodies masquerading as complete.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.cache())
}

function rawRequest(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    let headers
    const chunks = []
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc, h) {
        statusCode = sc
        headers = h
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      },
      onComplete() {
        resolve({ statusCode, headers, body: Buffer.concat(chunks).toString() })
      },
      onError: reject,
    })
  })
}

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

const FULL_BODY = '0123456789' // 10 bytes

// A minimal origin that honours single closed/open byte ranges over FULL_BODY
// and counts hits. Suffix and multi ranges are answered with 200 + full body
// (a server MAY ignore Range) unless opts.strictRange, which answers them
// properly (suffix) so storability of those responses can be observed.
function rangeServer({ maxAge = 60, etag = null, onRequest = null } = {}) {
  const state = { hits: 0, requests: [] }
  state.handler = (req, res) => {
    state.hits++
    state.requests.push({ headers: { ...req.headers }, method: req.method, url: req.url })
    onRequest?.(req, res)
    if (res.writableEnded) return

    const baseHeaders = { 'cache-control': `max-age=${maxAge}` }
    if (etag) baseHeaders.etag = etag

    const range = req.headers.range
    let m
    if (range && (m = /^bytes=(\d+)-(\d*)$/.exec(range))) {
      const start = Number(m[1])
      const end = m[2] === '' ? FULL_BODY.length - 1 : Number(m[2])
      const slice = FULL_BODY.slice(start, end + 1)
      res.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${start}-${start + slice.length - 1}/${FULL_BODY.length}`,
      })
      res.end(slice)
    } else if (range && (m = /^bytes=-(\d+)$/.exec(range))) {
      const suffix = Number(m[1])
      const start = FULL_BODY.length - suffix
      const slice = FULL_BODY.slice(start)
      res.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${start}-${FULL_BODY.length - 1}/${FULL_BODY.length}`,
      })
      res.end(slice)
    } else {
      res.writeHead(200, baseHeaders)
      res.end(FULL_BODY)
    }
  }
  return state
}

function makeOpts(server, extra = {}) {
  const store = new SqliteCacheStore({ location: ':memory:' })
  return {
    store,
    base: {
      origin: `http://127.0.0.1:${server.address().port}`,
      path: '/',
      method: 'GET',
      headers: {},
      cache: { store },
      ...extra,
    },
  }
}

// ---------------------------------------------------------------------------
// Storing and exact-window serving
// ---------------------------------------------------------------------------

test('range: exact closed range served from cached 206 with Age', async (t) => {
  t.plan(7)
  const origin = rangeServer()
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  const first = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(first.statusCode, 206)
  t.equal(first.body, '2345')
  await flush()

  const second = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(second.statusCode, 206, 'served as 206')
  t.equal(second.body, '2345', 'same bytes')
  t.equal(second.headers['content-range'], 'bytes 2-5/10', 'stored Content-Range replayed')
  t.ok(second.headers.age !== undefined, 'Age header added on hit')
  t.equal(origin.hits, 1, 'second request served from cache')
})

test('range: request without Range never sees a stored 206', async (t) => {
  t.plan(4)
  const origin = rangeServer()
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  const first = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(first.statusCode, 206)
  await flush()

  const second = await rawRequest(dispatch, base)
  t.equal(second.statusCode, 200, 'full 200 fetched, not the cached partial')
  t.equal(second.body, FULL_BODY, 'complete body')
  t.equal(origin.hits, 2, 'origin refetched for the non-range request')
})

test('range: different window than cached 206 goes to origin', async (t) => {
  t.plan(5)
  const origin = rangeServer()
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  await flush()

  const other = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=3-5' } })
  t.equal(other.statusCode, 206)
  t.equal(other.body, '345', 'correct bytes for the new window, not the cached ones')
  t.equal(other.headers['content-range'], 'bytes 3-5/10')
  t.equal(origin.hits, 2, 'cache did not serve a mismatched window')

  // Sub-window of the cached one must not be sliced out of it either.
  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=3-4' } })
  t.equal(origin.hits, 3, 'no slicing of a wider cached window')
})

test('range: distinct 206 windows coexist and each serves exactly', async (t) => {
  t.plan(5)
  const origin = rangeServer()
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=0-4' } })
  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=5-9' } })
  await flush()
  t.equal(origin.hits, 2)

  const a = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=0-4' } })
  const b = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=5-9' } })
  t.equal(a.body, '01234')
  t.equal(b.body, '56789')
  t.equal(a.headers['content-range'], 'bytes 0-4/10')
  t.equal(origin.hits, 2, 'both windows served from cache')
})

test('range: cached 200 serves a closed full-body range, misses partial ranges', async (t) => {
  t.plan(5)
  const origin = rangeServer()
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  const full = await rawRequest(dispatch, base)
  t.equal(full.statusCode, 200)
  await flush()

  // Exact full-body closed range matches the stored 200 row.
  const exact = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=0-9' } })
  t.equal(exact.statusCode, 200, 'served from cache as the stored 200')
  t.equal(exact.body, FULL_BODY)
  t.equal(origin.hits, 1, 'no origin fetch for the exact full range')

  // A partial range is not sliced out of the cached 200 — origin answers.
  const part = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-4' } })
  t.equal(part.body, '234', 'origin-served bytes are correct')
})

// ---------------------------------------------------------------------------
// Unsupported range forms are forwarded, never wrongly served
// ---------------------------------------------------------------------------

test('range: suffix and multi ranges forward to origin with correct results', async (t) => {
  t.plan(6)
  const origin = rangeServer()
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  // Prime with a full 200 so a buggy match would have something to serve.
  await rawRequest(dispatch, base)
  await flush()

  const suffix = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=-3' } })
  t.equal(suffix.statusCode, 206)
  t.equal(suffix.body, '789', 'suffix range answered by origin')
  t.equal(origin.hits, 2)

  const multi = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=0-1, 3-4' } })
  t.equal(multi.statusCode, 200, 'origin ignored the multi-range (its choice)')
  t.equal(multi.body, FULL_BODY)
  t.equal(origin.hits, 3, 'multi range not served from cache')
})

test('range: duplicated Range header is a miss, not a crash or wrong serve', async (t) => {
  t.plan(3)
  const origin = rangeServer()
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  await flush()

  // Node joins duplicate incoming Range lines into "bytes=2-5, bytes=0-1",
  // which the origin ignores (a server MAY ignore Range) — full 200 comes back.
  const dup = await rawRequest(dispatch, {
    ...base,
    headers: { range: ['bytes=2-5', 'bytes=0-1'] },
  })
  t.equal(dup.statusCode, 200, 'origin answered with the full response')
  t.equal(dup.body, FULL_BODY, 'no mixed-window body')
  t.equal(origin.hits, 2, 'not served from cache')
})

// ---------------------------------------------------------------------------
// Storability of partial responses
// ---------------------------------------------------------------------------

test('range: 206 without Content-Range is not stored', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(206, { 'cache-control': 'max-age=60' })
    res.end('2345')
  })
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  await flush()
  const second = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(second.statusCode, 206)
  t.equal(hits, 2, 'not served from cache')
})

test('range: 206 with invalid Content-Range is not stored', async (t) => {
  t.plan(2)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    // end (1) <= start (4) — nonsensical window
    res.writeHead(206, { 'cache-control': 'max-age=60', 'content-range': 'bytes 4-1/10' })
    res.end('2345')
  })
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  await flush()
  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(hits, 2, 'invalid window never cached')
  t.pass()
})

test('range: Content-Range with wildcard size stores and serves exactly', async (t) => {
  t.plan(3)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(206, { 'cache-control': 'max-age=60', 'content-range': 'bytes 2-5/*' })
    res.end('2345')
  })
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  await flush()
  const second = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(second.statusCode, 206)
  t.equal(second.body, '2345')
  t.equal(hits, 1, 'wildcard-size window served from cache')
})

test('range: HEAD response with Content-Range is not stored', async (t) => {
  t.plan(1)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    res.writeHead(206, {
      'cache-control': 'max-age=60',
      'content-range': 'bytes 2-5/10',
      'content-length': '4',
    })
    res.end()
  })
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  await rawRequest(dispatch, { ...base, method: 'HEAD', headers: { range: 'bytes=2-5' } })
  await flush()
  await rawRequest(dispatch, { ...base, method: 'HEAD', headers: { range: 'bytes=2-5' } })
  t.equal(hits, 2, 'HEAD range response never cached')
})

// ---------------------------------------------------------------------------
// Staleness, revalidation and conditional interplay
// ---------------------------------------------------------------------------

test('range: stale 206 is refetched, not conditionally revalidated', async (t) => {
  t.plan(6)
  const origin = rangeServer({ maxAge: 0, etag: '"tag-1"' })
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  const first = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(first.statusCode, 206)
  await flush()

  // Prove the entry actually exists in the store (otherwise the refetch
  // assertions below would also pass for a never-stored response): a
  // max-stale request must serve it without touching the origin.
  const staleServe = await rawRequest(dispatch, {
    ...base,
    headers: { range: 'bytes=2-5', 'cache-control': 'max-stale' },
  })
  t.equal(staleServe.body, '2345')
  t.equal(origin.hits, 1, 'stale entry is present and servable via max-stale')

  // max-age=0 + etag: entry is stored (validator present) but stale at once.
  const second = await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(second.statusCode, 206)
  t.equal(origin.hits, 2, 'refetched from origin')
  t.notOk(
    origin.requests[1].headers['if-none-match'],
    '206 entries are refetched without conditional headers',
  )
})

test('range: stale 206 served under request max-stale', async (t) => {
  t.plan(3)
  const origin = rangeServer({ maxAge: 0, etag: '"tag-1"' })
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  await flush()

  const stale = await rawRequest(dispatch, {
    ...base,
    headers: { range: 'bytes=2-5', 'cache-control': 'max-stale' },
  })
  t.equal(stale.statusCode, 206)
  t.equal(stale.body, '2345')
  t.equal(origin.hits, 1, 'served stale from cache under max-stale')
})

test('range: If-Range requests bypass the cache in both directions', async (t) => {
  t.plan(3)
  const origin = rangeServer({ etag: '"tag-1"' })
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  // Prime a fresh full 200.
  await rawRequest(dispatch, base)
  await flush()

  const ifRange = await rawRequest(dispatch, {
    ...base,
    headers: { range: 'bytes=2-5', 'if-range': '"tag-1"' },
  })
  t.equal(ifRange.statusCode, 206, 'origin answered the If-Range request')
  t.equal(origin.hits, 2, 'bypassed the fresh cached 200')

  // And the bypassed 206 must not have been stored either.
  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(origin.hits, 3, 'If-Range response was not written back')
})

test('range: Vary keeps 206 windows apart per variant', async (t) => {
  t.plan(4)
  let hits = 0
  const server = await startServer((req, res) => {
    hits++
    const lang = req.headers['accept-language'] ?? 'none'
    res.writeHead(206, {
      'cache-control': 'max-age=60',
      'content-range': 'bytes 0-3/10',
      vary: 'accept-language',
    })
    res.end(lang === 'en' ? 'EEEE' : 'FFFF')
  })
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  const en = await rawRequest(dispatch, {
    ...base,
    headers: { range: 'bytes=0-3', 'accept-language': 'en' },
  })
  t.equal(en.body, 'EEEE')
  await flush()

  const fr = await rawRequest(dispatch, {
    ...base,
    headers: { range: 'bytes=0-3', 'accept-language': 'fr' },
  })
  t.equal(fr.body, 'FFFF', 'different variant fetched from origin')
  t.equal(hits, 2)
  await flush()

  const enAgain = await rawRequest(dispatch, {
    ...base,
    headers: { range: 'bytes=0-3', 'accept-language': 'en' },
  })
  t.equal(enAgain.body, 'EEEE', 'matching variant served from cache')
})

test('range: unsafe method invalidates stored 206 windows', async (t) => {
  t.plan(2)
  const origin = rangeServer()
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  await flush()

  // POST to the same path — 200 response invalidates the URI.
  await rawRequest(dispatch, { ...base, method: 'POST', headers: {}, body: 'x' })
  await flush()

  await rawRequest(dispatch, { ...base, headers: { range: 'bytes=2-5' } })
  t.equal(origin.hits, 3, '206 window was invalidated by the POST')
  t.pass()
})

test('range: cached 206 body integrity across many alternating windows', async (t) => {
  const origin = rangeServer()
  const server = await startServer(origin.handler)
  t.teardown(server.close.bind(server))
  const dispatch = makeDispatch()
  const { base } = makeOpts(server)

  const windows = [
    [0, 2],
    [3, 5],
    [6, 9],
    [1, 4],
    [5, 8],
  ]
  for (const [s, e] of windows) {
    const res = await rawRequest(dispatch, { ...base, headers: { range: `bytes=${s}-${e}` } })
    t.equal(res.body, FULL_BODY.slice(s, e + 1), `origin bytes=${s}-${e}`)
  }
  await flush()
  const before = origin.hits
  for (const [s, e] of windows) {
    const res = await rawRequest(dispatch, { ...base, headers: { range: `bytes=${s}-${e}` } })
    t.equal(res.body, FULL_BODY.slice(s, e + 1), `cached bytes=${s}-${e}`)
    t.equal(res.statusCode, 206)
  }
  t.equal(origin.hits, before, 'all windows served from cache with intact bodies')
  t.end()
})
