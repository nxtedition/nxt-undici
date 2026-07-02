// Regression tests for the fourth in-depth review pass:
//  - pressure: a successful upgrade (HTTP 101) settles the per-origin record.
//    Upgrade is a terminal handler branch — client-h1 nulls the queue slot and
//    neither onComplete nor onError ever follows — so pre-fix the record was
//    stuck with running >= 1 forever: it could never satisfy the eviction
//    condition (rec.running === 0) and the 200 ms sampling interval kept
//    firing for the process lifetime.
import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import tp from 'node:timers/promises'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

const ORIGIN = 'http://example.test'
const noopHandler = { onConnect() {}, onHeaders() {}, onData() {}, onComplete() {}, onError() {} }

// Same synthetic-driving helpers as pressure-advanced.js: capture the wrapped
// handler instead of doing I/O, disable the internal timer (sampleInterval: 0)
// and drive sampling by hand with a tiny tau so one sample ≈ the instantaneous
// value.
function capturingDispatch() {
  const captured = []
  const dispatch = (opts, handler) => {
    captured.push(handler)
  }
  return { dispatch, captured }
}

function makeInterceptor(opts) {
  return interceptors.pressure({ sampleInterval: 0, tau: 0.001, ...opts })
}

async function tick(interceptor) {
  await tp.setTimeout(2)
  interceptor.sample()
}

// ---------------------------------------------------------------------------
// a successful upgrade settles the record as a success and forwards downstream
// ---------------------------------------------------------------------------

test('pressure: a successful upgrade (101) settles the record and reaches downstream', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  let upgraded = null
  const handler = {
    ...noopHandler,
    onUpgrade(statusCode, headers, socket) {
      upgraded = { statusCode, headers, socket }
    },
  }

  wrapped({ origin: ORIGIN, path: '/', upgrade: 'websocket' }, handler)
  captured[0].onConnect(() => {})
  t.match(p.stats(ORIGIN), { pending: 0, running: 1, completed: 0 }, 'in-flight before upgrade')

  const fakeSocket = { on() {}, end() {}, destroy() {} }
  captured[0].onUpgrade(101, { upgrade: 'websocket' }, fakeSocket)

  t.match(
    p.stats(ORIGIN),
    { pending: 0, running: 0, completed: 1, errored: 0 },
    'upgrade settled as a success: running back to 0, completed counted, not an error',
  )
  t.equal(upgraded?.statusCode, 101, 'downstream handler received onUpgrade')
  t.equal(upgraded?.socket, fakeSocket, 'downstream handler received the socket')

  // Fully idle and decayed -> the record must now be evictable (pre-fix the
  // stuck running gauge pinned it, and with it the sampling timer, forever).
  await tick(p)
  t.equal(p.stats(ORIGIN), undefined, 'record evicted once idle and decayed')

  p.close()
})

// ---------------------------------------------------------------------------
// settle-once: a late terminal callback after the upgrade cannot double-count
// ---------------------------------------------------------------------------

test('pressure: upgrade settles exactly once — a late onComplete/onError does not double-count', async (t) => {
  const p = makeInterceptor()
  const { dispatch, captured } = capturingDispatch()
  const wrapped = p(dispatch)

  wrapped({ origin: ORIGIN, path: '/', upgrade: 'websocket' }, { ...noopHandler, onUpgrade() {} })
  captured[0].onConnect(() => {})
  captured[0].onUpgrade(101, {}, { on() {}, end() {}, destroy() {} })
  captured[0].onComplete()
  captured[0].onError(new Error('late'))

  t.match(
    p.stats(ORIGIN),
    { pending: 0, running: 0, completed: 1, errored: 0 },
    'gauges settled exactly once across terminal callbacks',
  )

  p.close()
})

// ---------------------------------------------------------------------------
// integration: a real upgraded request through a real dispatcher
// ---------------------------------------------------------------------------

test('pressure: a real upgraded request settles the record and yields a usable socket', async (t) => {
  const server = createServer((req, res) => res.end('ok'))
  server.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'connection: upgrade\r\n' +
        'upgrade: websocket\r\n' +
        '\r\n',
    )
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const origin = `http://127.0.0.1:${server.address().port}`
  const p = makeInterceptor()
  t.teardown(() => p.close())

  const agent = new undici.Agent()
  t.teardown(() => agent.close())
  const dispatch = compose(agent, p)

  const { statusCode, socket } = await new Promise((resolve, reject) => {
    dispatch(
      { origin, path: '/', method: 'GET', upgrade: 'websocket', headers: {} },
      {
        onConnect() {},
        onUpgrade(statusCode, headers, socket) {
          resolve({ statusCode, socket })
        },
        onHeaders() {
          return true
        },
        onData() {},
        onComplete() {},
        onError: reject,
      },
    )
  })

  t.equal(statusCode, 101, 'downstream handler received the upgrade')
  t.ok(socket && !socket.destroyed, 'upgraded socket is usable')
  socket.destroy()

  t.match(
    p.stats(origin),
    { pending: 0, running: 0, completed: 1, errored: 0 },
    'record settled after the real upgrade',
  )
})
