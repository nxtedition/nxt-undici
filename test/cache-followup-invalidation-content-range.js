// Follow-up regression coverage for two correctness bugs that were fixed on an
// intermediate branch (PR #66) which never reached `main`:
//
//   1. invalidation-handler used `new URL(path, origin)` to build the base for
//      resolving Location/Content-Location. A request path beginning with `//`
//      (e.g. `//api/items/1`, reachable via a URL like `http://host//api/...`)
//      is parsed as a protocol-relative authority, so the base origin becomes
//      garbage and an absolute same-origin Location is judged cross-origin and
//      its invalidation silently skipped (stale-after-write).
//
//   2. cache-handler accepted a 206 whose Content-Range is the grammar-invalid
//      open-ended form `bytes N-/M` (no last-byte-pos). parseContentRange
//      yields end === null, which the `end != null &&` guard let slip through,
//      so a malformed partial was stored and could later be replayed.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { interceptors, compose } from '../lib/index.js'
import undici from '@nxtedition/undici'

function makeDispatch(cacheOpts) {
  return compose(new undici.Agent(), interceptors.cache(cacheOpts))
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

const origin = (server) => `http://127.0.0.1:${server.address().port}`

// A store that records the keys it stored and deleted — the observable signal
// of the write / invalidation paths actually running.
function spyStore() {
  const sets = []
  const deletes = []
  return {
    sets,
    deletes,
    get: () => undefined,
    set: (key) => {
      sets.push(key)
    },
    delete: (key) => {
      deletes.push(key)
    },
  }
}

test('invalidation resolves an absolute same-origin Location against a `//`-prefixed request path', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    // A non-error response to an unsafe method (POST) that points at a sibling,
    // absolute, same-origin resource it just mutated.
    res.writeHead(200, { location: `${origin(server)}/items/1` })
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const store = spyStore()
  const dispatch = makeDispatch()

  await rawRequest(dispatch, {
    origin: origin(server),
    // Protocol-relative path: `new URL('//api/items/1', origin)` would read
    // `//api` as the authority and corrupt the invalidation base origin.
    path: '//api/items/1',
    method: 'POST',
    headers: {},
    cache: { store },
  })

  const deletedPaths = store.deletes.map((k) => k.path)
  t.ok(
    deletedPaths.includes('//api/items/1'),
    'the target URI of the unsafe request is always invalidated',
  )
  t.ok(
    deletedPaths.includes('/items/1'),
    'the absolute same-origin Location is invalidated (not skipped as cross-origin)',
  )
})

test('a 206 with an open-ended Content-Range (`bytes N-/M`) is not stored', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    // Grammar-invalid open-ended byte-range-resp with start past the size.
    res.writeHead(206, {
      'content-range': 'bytes 15-/10',
      'cache-control': 'max-age=60',
      'content-type': 'application/octet-stream',
    })
    res.end('partial')
  })
  t.teardown(server.close.bind(server))

  const store = spyStore()
  const dispatch = makeDispatch()

  const res = await rawRequest(dispatch, {
    origin: origin(server),
    path: '/resource',
    method: 'GET',
    headers: { range: 'bytes=15-' },
    cache: { store },
  })

  t.equal(res.statusCode, 206, 'the response is still delivered to the caller')
  t.equal(store.sets.length, 0, 'the malformed partial is refused storage')
})
