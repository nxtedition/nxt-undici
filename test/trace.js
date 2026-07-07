import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, Agent } from '../lib/index.js'
import { installTrace } from '../lib/trace.js'

// The per-thread default writer slot (the legacy __nxt_lib_trace var is
// deprecated). Reads may go through the slot; installs must go through
// installTrace so the package's module-local mirror updates synchronously.
const kTrace = Symbol.for('@nxtedition/app/trace')

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
// start/end pair emitted with correct shape
// ---------------------------------------------------------------------------

test('trace: start/end pair with correct shape', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const origin = `http://127.0.0.1:${server.address().port}`

  const { body, statusCode } = await request(origin, {
    trace: writer,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()
  t.equal(statusCode, 200)

  t.equal(writer.docs.length, 2)

  const [start, end] = writer.docs

  t.equal(start.op, 'undici:request')
  t.equal(start.phase, 'start')
  t.type(start.id, 'string')
  t.match(start.id, /^req-/)
  t.equal(start.method, 'GET')
  t.equal(start.url, `${origin}/`)

  t.equal(end.op, 'undici:request')
  t.equal(end.phase, 'end')
  t.equal(end.id, start.id)
  t.equal(end.method, 'GET')
  t.equal(end.url, `${origin}/`)
  t.equal(end.statusCode, 200)
  t.type(end.durationMs, 'number')
  t.ok(end.durationMs >= 0)
  t.equal(end.durationMs, Math.round(end.durationMs))
  t.equal(end.bytes, 5)
  t.equal(end.err, null)
})

// ---------------------------------------------------------------------------
// url is bounded to 256 characters
// ---------------------------------------------------------------------------

test('trace: url bounded to 256 characters', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const origin = `http://127.0.0.1:${server.address().port}`

  const { body } = await request(`${origin}/${'x'.repeat(1024)}`, {
    trace: writer,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()

  t.equal(writer.docs.length, 2)
  t.equal(writer.docs[0].url.length, 256)
  t.equal(writer.docs[1].url, writer.docs[0].url)
})

// ---------------------------------------------------------------------------
// error path (socket destroyed pre-response) → end doc with err tag
// ---------------------------------------------------------------------------

test('trace: error path emits end doc with err tag and null statusCode', async (t) => {
  const server = await startServer((req, res) => {
    res.destroy()
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()

  await t.rejects(
    request(`http://127.0.0.1:${server.address().port}`, {
      trace: writer,
      retry: false,
      dispatcher: makeDispatcher(t),
    }),
  )

  t.equal(writer.docs.length, 2)

  const [start, end] = writer.docs
  t.equal(start.phase, 'start')
  t.equal(end.phase, 'end')
  t.equal(end.id, start.id)
  t.equal(end.statusCode, null)
  t.type(end.durationMs, 'number')
  t.type(end.err, 'string')
  t.ok(end.err.length > 0)
})

// ---------------------------------------------------------------------------
// retry path emits undici:retry
// ---------------------------------------------------------------------------

test('trace: retry emits undici:retry', async (t) => {
  let x = 0
  const server = await startServer((req, res) => {
    res.statusCode = x++ ? 200 : 429
    res.end('ok')
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()

  const { body, statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    trace: writer,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()
  t.equal(statusCode, 200)

  const requests = writer.docs.filter((doc) => doc.op === 'undici:request')
  const retries = writer.docs.filter((doc) => doc.op === 'undici:retry')

  t.equal(requests.length, 2)
  t.equal(requests[1].statusCode, 200)

  t.equal(retries.length, 1)
  const [retry] = retries
  t.equal(retry.id, requests[0].id)
  t.equal(retry.method, 'GET')
  t.equal(retry.url, requests[0].url)
  t.equal(retry.retryCount, 0)
  t.type(retry.delayMs, 'number')
  t.equal(retry.err, '429')
})

// ---------------------------------------------------------------------------
// trace: null disables despite installed global writer
// ---------------------------------------------------------------------------

test('trace: null disables despite global writer', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  // installTrace (not a bare slot assignment): the package mirrors the slot
  // module-locally and only installTrace updates it synchronously.
  const prev = globalThis[kTrace]
  installTrace(writer)
  t.teardown(() => {
    installTrace(prev)
  })

  const { body, statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    trace: null,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()

  t.equal(statusCode, 200)
  t.equal(writer.docs.length, 0)
})

// ---------------------------------------------------------------------------
// global fallback: absent option uses the installed per-thread writer
// ---------------------------------------------------------------------------

test('trace: global fallback used when option absent', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const prev = globalThis[kTrace]
  installTrace(writer)
  t.teardown(() => {
    installTrace(prev)
  })

  const { body, statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    dispatcher: makeDispatcher(t),
  })
  await body.dump()

  t.equal(statusCode, 200)
  t.equal(writer.docs.length, 2)
  t.equal(writer.docs[0].phase, 'start')
  t.equal(writer.docs[1].phase, 'end')
  t.equal(writer.docs[1].statusCode, 200)
})

// ---------------------------------------------------------------------------
// { write: null } is inert (explicit writer wins over global, write null = off)
// ---------------------------------------------------------------------------

test('trace: { write: null } is inert', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const globalWriter = makeWriter()
  const prev = globalThis[kTrace]
  installTrace(globalWriter)
  t.teardown(() => {
    installTrace(prev)
  })

  const { body, statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    trace: { write: null },
    dispatcher: makeDispatcher(t),
  })
  await body.dump()

  t.equal(statusCode, 200)
  t.equal(globalWriter.docs.length, 0)
})

// ---------------------------------------------------------------------------
// throwing writer → request still completes + process 'warning'
// ---------------------------------------------------------------------------

test('trace: throwing writer emits warning, request still completes', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const warning = once(process, 'warning')

  const { body, statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    trace: {
      write() {
        throw new Error('writer boom')
      },
    },
    dispatcher: makeDispatcher(t),
  })
  await body.dump()
  t.equal(statusCode, 200)

  const [warn] = await warning
  t.match(warn.message, /writer boom/)
})

// ---------------------------------------------------------------------------
// invalid trace option → InvalidArgumentError
// ---------------------------------------------------------------------------

test('trace: invalid trace option rejects with InvalidArgumentError', async (t) => {
  // No server: validation throws before anything connects.
  const origin = 'http://127.0.0.1:1'

  for (const trace of [42, 'nope', {}, { write: 42 }, { write: 'nope' }]) {
    try {
      await request(origin, { trace })
      t.fail(`should have rejected for ${JSON.stringify(trace)}`)
    } catch (err) {
      t.equal(err.name, 'InvalidArgumentError', `rejects for ${JSON.stringify(trace)}`)
      t.equal(err.code, 'UND_ERR_INVALID_ARG')
      t.match(err.message, /invalid trace/)
    }
  }
})

// ---------------------------------------------------------------------------
// upgrade path: end doc emitted when the upgraded socket closes
// ---------------------------------------------------------------------------

test('trace: upgrade emits end doc on socket close, bytes null', async (t) => {
  const { interceptors } = await import('../lib/index.js')
  const { EventEmitter } = await import('node:events')

  const writer = makeWriter()
  const socket = new EventEmitter()

  // Unit-level: drive the log interceptor's handler directly with an upgrade
  // so the pairing is asserted without a WebSocket server.
  const inner = (opts, handler) => {
    handler.onUpgrade(101, [], socket)
    return true
  }
  const dispatch = interceptors.log()(inner)
  dispatch(
    { origin: 'http://example.com', path: '/ws', method: 'GET', id: 'req-up', trace: writer },
    {
      onUpgrade() {},
    },
  )

  t.equal(writer.docs.length, 1, 'only the start doc before the socket closes')
  t.match(writer.docs[0], { op: 'undici:request', phase: 'start', id: 'req-up' })

  socket.emit('close')

  t.equal(writer.docs.length, 2, 'end doc emitted on socket close')
  t.match(writer.docs[1], {
    op: 'undici:request',
    phase: 'end',
    id: 'req-up',
    statusCode: 101,
    bytes: null,
    err: null,
  })
  t.equal(typeof writer.docs[1].durationMs, 'number')

  socket.emit('close')
  t.equal(writer.docs.length, 2, 'a second close does not double-emit')
})

// ---------------------------------------------------------------------------
// sync dispatch throw: start doc is still paired with an end doc
// ---------------------------------------------------------------------------

test('trace: sync dispatch throw pairs the start doc with an err end doc', async (t) => {
  const { interceptors } = await import('../lib/index.js')

  const writer = makeWriter()
  const boom = Object.assign(new Error('boom'), { code: 'EBOOM' })

  const dispatch = interceptors.log()(() => {
    throw boom
  })

  t.throws(
    () =>
      dispatch(
        { origin: 'http://example.com', path: '/', method: 'GET', id: 'req-sync', trace: writer },
        {},
      ),
    boom,
    'the dispatch error is rethrown to outer interceptors',
  )

  t.equal(writer.docs.length, 2, 'start and end docs both emitted')
  t.match(writer.docs[0], { op: 'undici:request', phase: 'start', id: 'req-sync' })
  t.match(writer.docs[1], {
    op: 'undici:request',
    phase: 'end',
    id: 'req-sync',
    statusCode: null,
    err: 'EBOOM',
  })
})
