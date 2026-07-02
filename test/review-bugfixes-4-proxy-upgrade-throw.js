// Regression tests for a hang in the proxy interceptor's onUpgrade:
//  - proxy: reduceHeaders throwing during onUpgrade (e.g. an inbound Forwarded
//    header on the 101 response → BadGateway) used to escape into undici's H1
//    upgrade path, which has already nulled the request's queue slot and whose
//    catch only destroys the socket — no onError ever reached the handler
//    chain, so the upgrade caller waited forever. The fix catches the throw,
//    delivers onError downstream and destroys the upgraded socket.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

// Every await in here must be bounded: the pre-fix failure mode is a hang
// (neither onUpgrade nor onError is ever delivered), so a lost race must
// surface as a bounded assertion failure rather than an infinite hang.
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    sleep(ms, undefined, { ref: false }).then(() => {
      throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    }),
  ])
}

async function startUpgradeServer(extraResponseHeaders) {
  const server = createServer((req, res) => res.end())
  const sockets = []
  const teardowns = []
  server.on('upgrade', (req, socket) => {
    sockets.push(socket)
    // Observe the client tearing the connection down. http.Server sockets are
    // allowHalfOpen, so a client FIN surfaces as 'end' (not 'close'); an RST
    // surfaces as 'error'. Keep reading so either is actually noticed.
    teardowns.push(
      new Promise((resolve) => {
        socket.on('error', resolve).on('end', resolve).on('close', resolve)
        socket.resume()
      }),
    )
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        extraResponseHeaders +
        '\r\n',
    )
  })
  server.listen(0)
  await once(server, 'listening')
  return { server, sockets, teardowns }
}

function upgradeViaDispatch(dispatch, opts) {
  return new Promise((resolve, reject) => {
    dispatch(
      { method: 'GET', path: '/', upgrade: 'websocket', proxy: {}, ...opts },
      {
        onConnect() {},
        onUpgrade(statusCode, headers, socket) {
          resolve({ statusCode, headers, socket })
        },
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {
          reject(new Error('unexpected onComplete for upgrade request'))
        },
        onError: reject,
      },
    )
  })
}

// ---------------------------------------------------------------------------
// A 101 response carrying a Forwarded header (request-only per RFC 7239) makes
// reduceHeaders throw BadGateway. The caller must receive that error via
// onError within bounded time — pre-fix it hung forever — and the upgraded
// socket must be destroyed rather than leaked.
// ---------------------------------------------------------------------------

test('proxy: reduceHeaders throw during onUpgrade is delivered as onError, not a hang', async (t) => {
  t.plan(3)
  const { server, sockets, teardowns } = await startUpgradeServer('Forwarded: for=192.0.2.1\r\n')
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.proxy())
  const err = await withTimeout(
    upgradeViaDispatch(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
    }).then(
      () => {
        throw new Error('upgrade unexpectedly succeeded')
      },
      (err) => err,
    ),
    5000,
    'onError after reduceHeaders throw',
  )

  t.equal(err.statusCode, 502, 'BadGateway delivered to the caller via onError')
  t.equal(sockets.length, 1, 'server saw exactly one upgrade')

  // The client-side upgraded socket must have been destroyed — observe the
  // TCP teardown (FIN or RST) from the server side, bounded.
  await withTimeout(teardowns[0], 5000, 'server-side socket teardown')
  t.ok(true, 'upgraded socket destroyed (server observed connection teardown)')
})

// ---------------------------------------------------------------------------
// A looping Via (proxy.name matches an inbound Via segment) is the other
// reduceHeaders throw site — same terminal delivery requirement.
// ---------------------------------------------------------------------------

test('proxy: Via loop during onUpgrade is delivered as onError, not a hang', async (t) => {
  t.plan(1)
  const { server } = await startUpgradeServer('Via: HTTP/1.1 myproxy\r\n')
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.proxy())
  const err = await withTimeout(
    upgradeViaDispatch(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
      proxy: { name: 'myproxy' },
    }).then(
      () => {
        throw new Error('upgrade unexpectedly succeeded')
      },
      (err) => err,
    ),
    5000,
    'onError after Via loop throw',
  )

  t.equal(err.statusCode, 508, 'LoopDetected delivered to the caller via onError')
})

// ---------------------------------------------------------------------------
// A clean 101 (no offending headers) still upgrades through the proxy
// interceptor, with hop-by-hop headers stripped and the socket usable.
// ---------------------------------------------------------------------------

test('proxy: clean upgrade still works through the proxy interceptor', async (t) => {
  t.plan(4)
  const { server } = await startUpgradeServer('X-Custom: keep\r\n')
  t.teardown(server.close.bind(server))

  const dispatch = compose(new undici.Agent(), interceptors.proxy())
  const { statusCode, headers, socket } = await withTimeout(
    upgradeViaDispatch(dispatch, {
      origin: `http://127.0.0.1:${server.address().port}`,
    }),
    5000,
    'onUpgrade for a clean 101',
  )

  t.equal(statusCode, 101, 'upgrade delivered with 101 status')
  t.equal(headers['x-custom'], 'keep', 'non-hop-by-hop response header preserved')
  t.notOk(headers.connection, 'hop-by-hop connection header stripped')
  t.ok(socket && !socket.destroyed, 'upgraded socket delivered intact')

  socket.destroy()
})
