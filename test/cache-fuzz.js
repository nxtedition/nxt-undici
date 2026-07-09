/* eslint-disable */
// Randomized (fuzz) tests for the cache interceptor (nxtedition/nxt-undici#56).
//
// A seeded PRNG drives both sides: an origin that emits adversarial header
// combinations (malformed Cache-Control/Age/dates/ETags/Vary/Content-Range,
// unsolicited 304s, random statuses) and a client that issues random request
// sequences (methods, request directives, ranges, conditionals, duplicate
// header lines). Every response is checked against behavioral invariants that
// must hold regardless of how hostile the origin is:
//
//   I1  every request settles (no hang, no throw from the dispatch pipeline)
//   I2  a response body is always one the origin actually sent for that path
//       (no cross-path/cross-variant mixing, no truncation, no partial-as-full)
//   I3  a response the origin marked `Cache-Control: no-store` is never
//       replayed from cache
//   I4  a response first fetched for a request with `Cache-Control: no-store`
//       is never replayed from cache (write-back suppressed)
//   I5  `only-if-cached` yields a cached response or a synthetic 504
//   I6  a replayed 206 only answers a request that sent Range
//   I7  a replayed 304 only answers a request that sent a conditional
//   I8  Age on replayed responses is a non-negative integer
//   I9  a replayed response honours the Vary of the response that stored it
//
// "Replayed" is detected via a unique per-origin-response serial header: a
// serial seen more than once was served from cache. Detection is deliberately
// conservative (revalidation freshening merges the 304's serial) so the
// invariants cannot produce false positives.
//
// Failures print the seed; reproduce with NXT_FUZZ_SEED=<seed>. Iteration
// count is kept small for CI (NXT_FUZZ_ITERS to crank locally).
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose, cache as cacheModule } from '../lib/index.js'
import undici from '@nxtedition/undici'

const { SqliteCacheStore } = cacheModule

const SEED = Number(process.env.NXT_FUZZ_SEED) || (Date.now() ^ (process.pid << 8)) >>> 0
const ITERS = Number(process.env.NXT_FUZZ_ITERS) || 120

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makePicker(rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  const chance = (p) => rand() < p
  const int = (max) => Math.floor(rand() * max)
  return { pick, chance, int }
}

function rawRequest(dispatch, opts, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let statusCode = null
    let headers = null
    const chunks = []
    let abortFn = null
    let settled = false
    const timer = setTimeout(() => {
      const err = new Error(`fuzz request timed out after ${timeoutMs}ms`)
      err.name = 'AbortError'
      if (abortFn) abortFn(err)
      else {
        settled = true
        reject(err)
      }
    }, timeoutMs)
    const handler = {
      onConnect(abort) {
        abortFn = abort
      },
      onHeaders(sc, h) {
        if (sc >= 200) {
          statusCode = sc
          headers = h
        }
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        return true
      },
      onComplete() {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ statusCode, headers: headers ?? {}, body: Buffer.concat(chunks).toString() })
      },
      onError(err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    }
    try {
      dispatch(opts, handler)
    } catch (err) {
      handler.onError(err)
    }
  })
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// Adversarial origin
// ---------------------------------------------------------------------------

// Builds an origin whose responses are generated from the PRNG. Each response
// gets a unique x-fuzz-serial; the server records what it sent so the client
// can verify integrity. 304s are only sent to conditional requests (a 304 to
// an unconditional request is not deliverable by node's http client anyway).
function makeFuzzOrigin(rand, { rangeHeavy = false } = {}) {
  const { pick, chance, int } = makePicker(rand)
  let serial = 0
  const sent = new Map() // serial -> { body, path, noStore, vary, is304, is206 }
  const bodiesByPath = new Map() // path -> Set(body)

  const CC_POOL = [
    'max-age=0',
    'max-age=1',
    'max-age=60',
    'max-age=999999999999',
    'max-age=-5',
    'max-age=abc',
    'max-age=1.5',
    'max-age="60"',
    'max-age =60',
    'max-age',
    'no-store',
    'no-cache',
    // Qualified field-strip forms target x-strippable, never x-fuzz-serial:
    // stripping the bookkeeping header would make legitimate cache hits look
    // serial-less and false-positive the invariants (found by seed 314159).
    'no-cache="x-strippable"',
    'private',
    'private="x-strippable"',
    'private="x-private"',
    's-maxage=60',
    's-maxage=0',
    'must-revalidate',
    'proxy-revalidate',
    'immutable',
    'stale-while-revalidate=60',
    'stale-while-revalidate=1',
    'stale-if-error=60',
    'no-transform',
    'must-understand',
    'foo=bar',
    'foo="unclosed',
    ',,,',
    'MAX-AGE=60',
  ]
  const AGE_POOL = ['0', '5', '7200', 'abc', '-1', '7200, 0', '0, 7200', '1;p=2', '1.5', '']
  const DATE_POOL = [
    () => new Date().toUTCString(),
    () => new Date(Date.now() - 10_000).toUTCString(),
    () => new Date(Date.now() + 10_000).toUTCString(),
    () => 'invalid-date',
    () => '0',
    () => 'Thu, 01 Jan 1970 00:00:00 GMT',
    () => 'Sunday, 06-Nov-94 08:49:37 GMT',
    () => 'Sun Nov  6 08:49:37 1994',
  ]
  const ETAG_POOL = ['"e1"', '"e2"', 'W/"w1"', 'unquoted', '""', '"', 'W/""', '"a", "b"']
  const VARY_POOL = [null, null, 'x-var', 'x-var', '*', 'x-var, x-other', 'X-VAR']

  const handler = (req, res) => {
    const url = req.url
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const mySerial = ++serial
      const headers = { 'x-fuzz-serial': `${mySerial}` }
      const conditional = req.headers['if-none-match'] || req.headers['if-modified-since']
      // Origin-side no-store detection for invariant I4: every cache write
      // path is suppressed for a request carrying no-store, so any response
      // the origin hands to such a request must never be replayed. This is
      // exact (unlike client-side first-seen tracking, which SWR background
      // refreshes can fool: they store serials the client has never seen).
      const reqNoStore = `${req.headers['cache-control'] ?? ''}`.includes('no-store')

      // Unsafe methods: plain 200/204 answer (exercises invalidation).
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(pick([200, 204, 303, 500]), headers)
        res.end()
        sent.set(mySerial, {
          path: url,
          body: '',
          noStore: false,
          reqNoStore,
          vary: null,
          is304: false,
        })
        return
      }

      // Sometimes validate a conditional request.
      if (conditional && chance(0.35)) {
        if (chance(0.3)) headers['cache-control'] = pick(CC_POOL)
        if (chance(0.3)) headers.etag = req.headers['if-none-match'] ?? pick(ETAG_POOL)
        res.writeHead(304, headers)
        res.end()
        sent.set(mySerial, {
          path: url,
          body: '',
          noStore: false,
          reqNoStore,
          vary: null,
          is304: true,
        })
        return
      }

      const ccParts = []
      const nCC = int(4) // 0-3 directives
      for (let i = 0; i < nCC; i++) ccParts.push(pick(CC_POOL))
      const cc = ccParts.join(', ')
      if (cc) {
        // Occasionally as two separate lines instead of one list.
        if (ccParts.length > 1 && chance(0.2)) headers['cache-control'] = ccParts
        else headers['cache-control'] = cc
      }
      // Present sometimes so the qualified no-cache=/private= strip paths have
      // something real to strip.
      if (chance(0.3)) headers['x-strippable'] = 'strip-me'
      if (chance(0.2)) headers['x-private'] = 'p'
      if (chance(0.4)) headers.age = pick(AGE_POOL)
      if (chance(0.7)) headers.date = pick(DATE_POOL)()
      if (chance(0.3)) headers.expires = pick(DATE_POOL)()
      if (chance(0.4)) headers['last-modified'] = pick(DATE_POOL)()
      if (chance(0.4)) headers.etag = pick(ETAG_POOL)
      const vary = pick(VARY_POOL)
      if (vary) headers.vary = vary

      const varTag = req.headers['x-var'] ?? ''
      let body = `body-${url}-${varTag}-${int(3)}`
      let status = rangeHeavy
        ? pick([200, 200, 200, 206, 206, 307, 404, 503])
        : pick([200, 200, 200, 200, 200, 206, 307, 404, 500, 503])

      // Honour a valid closed request Range half the time so exact-window 206
      // entries get stored AND replayed (otherwise invariant I6 is dead code:
      // a stored window decoupled from the request range can never match).
      const rangeMatch = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
      if (rangeMatch && chance(0.5)) {
        const start = Number(rangeMatch[1])
        const end = Math.min(Number(rangeMatch[2]), body.length - 1)
        if (start <= end) {
          status = 206
          headers['content-range'] = `bytes ${start}-${end}/${body.length}`
          body = body.slice(start, end + 1)
        }
      } else if (status === 206) {
        const cr = pick([
          `bytes 0-${body.length - 1}/${body.length}`, // valid, matching
          `bytes 2-5/${body.length}`, // window not matching body length
          'bytes 4-1/10', // inverted
          'bytes 0-999999/12', // end > size
          `bytes 0-${body.length - 1}/*`, // wildcard size
          null, // 206 without Content-Range
        ])
        if (cr) headers['content-range'] = cr
        if (cr === `bytes 2-5/${body.length}`) body = body.slice(2, 6)
      }
      if (status === 307) headers.location = `${url}?redirected`

      const noStore =
        cc.includes('no-store') ||
        (Array.isArray(headers['cache-control']) &&
          headers['cache-control'].some((v) => v.includes('no-store')))
      res.writeHead(status, headers)
      res.end(req.method === 'HEAD' ? undefined : body)

      sent.set(mySerial, {
        path: url,
        body: req.method === 'HEAD' ? '' : body,
        noStore,
        reqNoStore,
        vary: typeof headers.vary === 'string' ? headers.vary : null,
        is304: false,
        is206: status === 206,
      })
      if (!bodiesByPath.has(url)) bodiesByPath.set(url, new Set(['']))
      bodiesByPath.get(url).add(body)
    })
  }

  return { handler, sent, bodiesByPath }
}

// ---------------------------------------------------------------------------
// Random request generation
// ---------------------------------------------------------------------------

function makeRequestGen(
  rand,
  origin,
  paths,
  { rangeHeavy = false, conditionalHeavy = false } = {},
) {
  const { pick, chance } = makePicker(rand)
  const REQ_CC = [
    null,
    null,
    null,
    'max-age=0',
    'max-age=1',
    'max-age=60',
    'no-cache',
    'no-store',
    'only-if-cached',
    'max-stale',
    'max-stale=60',
    'min-fresh=1',
    'stale-if-error=60',
    'no-cache, max-age=0',
    'garbage',
  ]
  const RANGE_POOL = [
    null,
    null,
    'bytes=0-3',
    'bytes=0-3',
    'bytes=2-',
    'bytes=-2',
    'bytes=0-1,4-5',
    'garbage',
    'bytes=9999-',
  ]

  return function generate() {
    const path = pick(paths)
    const headers = {}
    const cc = pick(REQ_CC)
    if (cc) headers['cache-control'] = chance(0.08) ? [cc, pick(REQ_CC) ?? 'max-age=5'] : cc
    if (chance(0.6)) headers['x-var'] = pick(['a', 'a', 'b', 'c'])
    if (chance(0.1)) headers['x-other'] = pick(['1', '2'])
    if (rangeHeavy ? chance(0.7) : chance(0.15)) {
      const r = pick(RANGE_POOL)
      if (r) headers.range = chance(0.05) ? [r, 'bytes=0-1'] : r
    }
    if (conditionalHeavy ? chance(0.5) : chance(0.12)) {
      if (chance(0.6)) headers['if-none-match'] = pick(['"e1"', '"e2"', 'W/"w1"', '*', 'garbage'])
      else headers['if-modified-since'] = pick([new Date().toUTCString(), 'invalid'])
    }
    const method = chance(0.08) ? pick(['POST', 'PUT', 'DELETE']) : chance(0.12) ? 'HEAD' : 'GET'
    const opts = { origin: origin, path, method, headers }
    if (method === 'POST' || method === 'PUT') opts.body = 'fuzz'
    return opts
  }
}

// ---------------------------------------------------------------------------
// Invariant checking
// ---------------------------------------------------------------------------

function makeInvariantChecker(t, originState, seedInfo) {
  const seen = new Map() // serial -> { requestHadRange, requestHadConditional, xVar, count }

  return function check(iter, opts, res) {
    const ctxOf = () =>
      `${seedInfo} iter=${iter} ${opts.method} ${opts.path} req=${JSON.stringify(opts.headers)} → ${res.statusCode} ${JSON.stringify(res.headers)}`

    const serialRaw = res.headers['x-fuzz-serial']
    const serial =
      serialRaw != null ? Number(Array.isArray(serialRaw) ? serialRaw[0] : serialRaw) : null

    const reqCC = JSON.stringify(opts.headers['cache-control'] ?? '')
    const requestOnlyIfCached = reqCC.includes('only-if-cached')
    const requestHadRange = opts.headers.range != null
    const requestHadConditional =
      opts.headers['if-none-match'] != null || opts.headers['if-modified-since'] != null

    // I2: body must be something the origin sent for this path.
    if (opts.method === 'GET' && res.body !== '') {
      const bodies = originState.bodiesByPath.get(opts.path)
      if (!(bodies && bodies.has(res.body))) {
        t.fail(`I2 foreign body "${res.body}" — ${ctxOf()}`)
      }
    }

    if (serial == null) {
      // Synthetic response (only-if-cached 504 / conditional 304 against an
      // entry stored before the serial header existed — cannot happen here).
      if (requestOnlyIfCached) {
        if (res.statusCode !== 504 && res.statusCode !== 304) {
          t.fail(`I5 only-if-cached yielded ${res.statusCode} without cache serial — ${ctxOf()}`)
        }
      }
      return
    }

    const meta = originState.sent.get(serial)
    const prior = seen.get(serial)
    if (prior === undefined) {
      seen.set(serial, {
        requestHadRange,
        xVar: opts.headers['x-var'] ?? null,
        count: 1,
      })
      return
    }

    // serial repeated → this response was replayed from cache.
    prior.count++

    // I3: origin-marked no-store must never be replayed.
    if (meta?.noStore) {
      t.fail(`I3 no-store response replayed (serial ${serial}) — ${ctxOf()}`)
    }
    // I4: a response the origin handed to a request that carried no-store must
    // never be replayed (all write-back paths are suppressed for it). Detected
    // origin-side — client-side first-seen tracking would false-positive on
    // serials stored invisibly by SWR background refreshes.
    if (meta?.reqNoStore) {
      t.fail(`I4 request-no-store response replayed (serial ${serial}) — ${ctxOf()}`)
    }
    // I6: replayed 206 only for Range requests.
    if (res.statusCode === 206 && !requestHadRange) {
      t.fail(`I6 cached 206 served to non-range request (serial ${serial}) — ${ctxOf()}`)
    }
    // I7: replayed 304 only for conditional requests.
    if (res.statusCode === 304 && !requestHadConditional) {
      t.fail(`I7 cached 304 served to unconditional request (serial ${serial}) — ${ctxOf()}`)
    }
    // I8: Age sanity on replays.
    const age = res.headers.age
    if (age !== undefined) {
      const ageValue = Array.isArray(age) ? age[0] : age
      if (!/^\d+$/.test(`${ageValue}`)) {
        t.fail(`I8 non-integer Age "${ageValue}" on cache hit — ${ctxOf()}`)
      }
    }
    // I9: Vary discipline. Only checked for entries stored straight from an
    // origin response that named exactly x-var (freshened entries carry the
    // 304's serial, never a previously-seen one, so `prior` is authoritative).
    if (meta && meta.vary && meta.vary.toLowerCase() === 'x-var' && !meta.is304) {
      const reqVar = opts.headers['x-var'] ?? null
      if (reqVar !== prior.xVar) {
        t.fail(
          `I9 vary violation: stored with x-var=${prior.xVar}, served to x-var=${reqVar} (serial ${serial}) — ${ctxOf()}`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

async function runCampaign(t, { seed, iters, rangeHeavy, conditionalHeavy, label }) {
  const rand = mulberry32(seed)
  const originState = makeFuzzOrigin(rand, { rangeHeavy })
  const server = createServer(originState.handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = compose(new undici.Agent(), interceptors.cache())
  const originUrl = `http://127.0.0.1:${server.address().port}`
  const paths = ['/a', '/b', '/c', '/d', '/e', '/f']
  const generate = makeRequestGen(rand, originUrl, paths, { rangeHeavy, conditionalHeavy })
  const check = makeInvariantChecker(t, originState, `[${label} seed=${seed}]`)

  for (let iter = 0; iter < iters; iter++) {
    const opts = { ...generate(), cache: { store } }
    let res
    try {
      res = await rawRequest(dispatch, opts) // I1: settles or fails loudly
    } catch (err) {
      t.fail(
        `I1 request threw: ${err.message} [${label} seed=${seed}] iter=${iter} ${opts.method} ${opts.path} req=${JSON.stringify(opts.headers)}`,
      )
      continue
    }
    check(iter, opts, res)
    await flush()
    // Let short-lived entries (max-age=1) actually expire now and then so the
    // stale/revalidation/SWR paths get exercised.
    if (iter % 40 === 39) {
      await new Promise((resolve) => setTimeout(resolve, 1100))
    }
  }
  t.pass(`${label}: ${iters} randomized requests upheld all invariants (seed=${seed})`)
}

test(`cache fuzz: storability chaos (seed=${SEED})`, { timeout: 120_000 }, async (t) => {
  await runCampaign(t, {
    seed: SEED,
    iters: ITERS,
    rangeHeavy: false,
    conditionalHeavy: false,
    label: 'storability',
  })
})

test(`cache fuzz: range chaos (seed=${SEED + 1})`, { timeout: 120_000 }, async (t) => {
  await runCampaign(t, {
    seed: SEED + 1,
    iters: ITERS,
    rangeHeavy: true,
    conditionalHeavy: false,
    label: 'range',
  })
})

test(`cache fuzz: conditional chaos (seed=${SEED + 2})`, { timeout: 120_000 }, async (t) => {
  await runCampaign(t, {
    seed: SEED + 2,
    iters: ITERS,
    rangeHeavy: false,
    conditionalHeavy: true,
    label: 'conditional',
  })
})

test(`cache fuzz: concurrent burst (seed=${SEED + 3})`, { timeout: 120_000 }, async (t) => {
  // No serial-based invariants here (races legitimately interleave) — this
  // hammers one path with mixed concurrent requests and checks that everything
  // settles with bodies the origin actually produced (I1 + I2).
  const rand = mulberry32(SEED + 3)
  const originState = makeFuzzOrigin(rand, { rangeHeavy: true })
  const server = createServer(originState.handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const store = new SqliteCacheStore({ location: ':memory:' })
  const dispatch = compose(new undici.Agent(), interceptors.cache())
  const originUrl = `http://127.0.0.1:${server.address().port}`
  const generate = makeRequestGen(rand, originUrl, ['/hot'], { rangeHeavy: true })

  for (let round = 0; round < 5; round++) {
    const burst = Array.from({ length: 16 }, () => {
      const opts = { ...generate(), cache: { store } }
      return rawRequest(dispatch, opts).then(
        (res) => ({ opts, res }),
        (err) => {
          t.fail(`I1 concurrent request threw: ${err.message} (seed=${SEED + 3})`)
          return null
        },
      )
    })
    const settledResults = await Promise.all(burst)
    for (const item of settledResults) {
      if (item == null || item.opts.method !== 'GET' || item.res.body === '') continue
      const bodies = originState.bodiesByPath.get(item.opts.path)
      if (!(bodies && bodies.has(item.res.body))) {
        t.fail(`I2 foreign body under concurrency "${item.res.body}" (seed=${SEED + 3})`)
      }
    }
    await flush()
  }
  t.pass(`concurrent burst upheld I1/I2 (seed=${SEED + 3})`)
})
