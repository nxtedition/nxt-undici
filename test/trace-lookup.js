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
// async callback lookup → one undici:lookup success doc
// ---------------------------------------------------------------------------

test('trace lookup: async callback lookup emits one undici:lookup doc', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const target = `http://127.0.0.1:${server.address().port}`

  const { body, statusCode } = await request('http://service.internal', {
    trace: writer,
    dispatcher: makeDispatcher(t),
    lookup: (origin, opts, callback) => {
      setTimeout(() => callback(null, target), 5)
    },
  })
  await body.dump()
  t.equal(statusCode, 200)

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:lookup')
  t.equal(lookups.length, 1)

  const [doc] = lookups
  t.type(doc.id, 'string')
  t.equal(doc.method, 'GET')
  t.equal(doc.url, 'http://service.internal/')
  t.equal(doc.resolved, target)
  t.equal(doc.err, null)
  t.type(doc.durationMs, 'number')
  t.ok(doc.durationMs >= 0)
  t.equal(doc.durationMs, Math.round(doc.durationMs))
})

// ---------------------------------------------------------------------------
// failing lookup → err doc, resolved null, request rejects
// ---------------------------------------------------------------------------

test('trace lookup: failing lookup emits err doc and the request rejects', async (t) => {
  const writer = makeWriter()

  await t.rejects(
    request('http://service.internal', {
      trace: writer,
      dispatcher: makeDispatcher(t),
      lookup: (origin, opts, callback) => {
        callback(Object.assign(new Error('no such service'), { code: 'ENOTFOUND' }))
      },
    }),
    /no such service/,
  )

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:lookup')
  t.equal(lookups.length, 1)

  const [doc] = lookups
  t.equal(doc.url, 'http://service.internal/')
  t.equal(doc.resolved, null)
  t.equal(doc.err, 'ENOTFOUND')
  t.type(doc.durationMs, 'number')
  t.ok(doc.durationMs >= 0)
})

// ---------------------------------------------------------------------------
// default lookup (sync) → NO undici:lookup docs
// ---------------------------------------------------------------------------

test('trace lookup: default lookup emits no undici:lookup docs', async (t) => {
  const server = await startServer()
  t.teardown(server.close.bind(server))

  const writer = makeWriter()

  const { body, statusCode } = await request(`http://127.0.0.1:${server.address().port}`, {
    trace: writer,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()
  t.equal(statusCode, 200)

  const lookups = writer.docs.filter((doc) => doc.op === 'undici:lookup')
  t.equal(lookups.length, 0)
})
