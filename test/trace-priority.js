import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, Agent, interceptors } from '../lib/index.js'
import { installTrace } from '../lib/trace.js'

async function startServer(handler) {
  const server = createServer(handler ?? ((req, res) => res.end('hello')))
  server.listen(0)
  await once(server, 'listening')
  return server
}

// Explicit dispatcher: under tap the global dispatcher may have been replaced
// by Node's built-in undici (fetch shares the globalDispatcher symbol), which
// rejects this library's handlers with "invalid onRequestStart method".
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
// uncontended request() with a priority → exactly one 'end' doc, no 'queued'
// ---------------------------------------------------------------------------

test('trace-priority: uncontended request emits one end doc and no queued doc', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const writer = makeWriter()

  const { body, statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    priority: 1,
    trace: writer,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()
  t.equal(statusCode, 200)

  const docs = writer.docs.filter((doc) => doc.op === 'undici:priority')
  t.equal(docs.length, 1, 'exactly one undici:priority doc')

  const [end] = docs
  t.equal(end.phase, 'end')
  t.type(end.id, 'string')
  t.match(end.id, /^req-/)
  t.type(end.key, 'string')
  t.ok(end.key.length > 0)
  t.equal(end.priority, '1')
  t.equal(end.pending, null)
  t.type(end.waitMs, 'number')
  t.ok(end.waitMs >= 0)
  t.equal(end.waitMs, Math.round(end.waitMs))
  t.type(end.holdMs, 'number')
  t.ok(end.holdMs >= 0)
  t.equal(end.holdMs, Math.round(end.holdMs))
})

// ---------------------------------------------------------------------------
// contended slot (unit-level, deterministic): 'queued' doc + paired end docs
// ---------------------------------------------------------------------------

test('trace-priority: contended slot emits queued doc, both requests get end docs', async (t) => {
  const writer = makeWriter()

  // Unit-level: drive the priority interceptor directly with an inner
  // dispatch that never fires callbacks on its own, so the concurrency=1
  // slot is deterministically held until the test releases it via onConnect.
  const handlers = []
  const inner = (opts, handler) => {
    handlers.push(handler)
    return true
  }
  const dispatch = interceptors.priority()(inner)

  const opts = {
    origin: 'http://example.com',
    path: '/',
    method: 'GET',
    headers: { host: 'example.com' },
    priority: 'high',
    trace: writer,
  }

  dispatch({ ...opts, id: 'req-1' }, {})
  t.equal(handlers.length, 1, 'first request dispatched synchronously (free slot)')
  t.equal(writer.docs.length, 0, 'no queued doc for an uncontended acquire')

  dispatch({ ...opts, id: 'req-2' }, {})
  t.equal(handlers.length, 1, 'second request queued, not dispatched')

  t.equal(writer.docs.length, 1)
  t.match(writer.docs[0], {
    op: 'undici:priority',
    phase: 'queued',
    id: 'req-2',
    key: 'http://example.com',
    priority: 'high',
    pending: 1,
    waitMs: null,
    holdMs: null,
  })

  // onConnect releases the slot; the queued request dispatches synchronously.
  handlers[0].onConnect(() => {})
  t.equal(handlers.length, 2, 'queued request dispatched on release')

  t.equal(writer.docs.length, 2)
  t.match(writer.docs[1], {
    op: 'undici:priority',
    phase: 'end',
    id: 'req-1',
    key: 'example.com',
    priority: 'high',
    pending: null,
  })
  t.type(writer.docs[1].waitMs, 'number')
  t.ok(writer.docs[1].waitMs >= 0)
  t.type(writer.docs[1].holdMs, 'number')
  t.ok(writer.docs[1].holdMs >= 0)

  handlers[1].onConnect(() => {})

  t.equal(writer.docs.length, 3)
  t.match(writer.docs[2], {
    op: 'undici:priority',
    phase: 'end',
    id: 'req-2',
    key: 'example.com',
    priority: 'high',
    pending: null,
  })
  t.type(writer.docs[2].waitMs, 'number')
  t.ok(writer.docs[2].waitMs >= 0)
  t.type(writer.docs[2].holdMs, 'number')
  t.ok(writer.docs[2].holdMs >= 0)

  // A later terminal callback funnels into the same once-guard as release():
  // no double emission.
  handlers[0].onComplete([])
  handlers[1].onComplete([])
  t.equal(writer.docs.length, 3, 'end docs do not double-fire')
})

// ---------------------------------------------------------------------------
// tracing off → no trace state, request unaffected
// ---------------------------------------------------------------------------

test('trace-priority: trace null emits nothing', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  // installTrace (not a bare slot assignment): the package mirrors the
  // per-thread slot module-locally and only installTrace updates it
  // synchronously.
  const prev = globalThis[Symbol.for('@nxtedition/app/trace')]
  installTrace(writer)
  t.teardown(() => {
    installTrace(prev)
  })

  const { body, statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    priority: 1,
    trace: null,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()

  t.equal(statusCode, 200)
  t.equal(writer.docs.length, 0)
})
