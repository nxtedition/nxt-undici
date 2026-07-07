import { test } from 'tap'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, Agent, interceptors } from '../lib/index.js'

async function startServer(handler) {
  const server = createServer(handler)
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
// size mismatch (lying Content-Range) → kind 'size' with exact sizes
// ---------------------------------------------------------------------------

test('trace-verify: size mismatch emits undici:verify doc with kind size', async (t) => {
  const server = await startServer((req, res) => {
    // Content-Range promises 10 bytes but content-length frames only 5 on the
    // wire: the transport delivers a valid 5-byte body that fails the
    // interceptor's content-range-derived size expectation on complete.
    res.writeHead(206, {
      'content-range': 'bytes 0-9/10',
      'content-length': '5',
    })
    res.end('short')
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const origin = `http://127.0.0.1:${server.address().port}`

  const { body } = await request(origin, {
    verify: { size: true },
    retry: false,
    trace: writer,
    dispatcher: makeDispatcher(t),
  })

  try {
    await body.text()
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /size mismatch/)
  }

  const docs = writer.docs.filter((doc) => doc.op === 'undici:verify')
  t.equal(docs.length, 1)

  const [doc] = docs
  t.equal(doc.kind, 'size')
  t.equal(doc.expectedSize, 10)
  t.equal(doc.actualSize, 5)
  t.equal(doc.expectedHash, null)
  t.equal(doc.actualHash, null)
  t.equal(doc.method, 'GET')
  t.equal(doc.url, `${origin}/`)
  t.type(doc.id, 'string')
  t.match(doc.id, /^req-/)
})

// ---------------------------------------------------------------------------
// content-md5 mismatch → kind 'hash' with exact bounded hashes
// ---------------------------------------------------------------------------

test('trace-verify: content-md5 mismatch emits undici:verify doc with kind hash', async (t) => {
  const payload = 'hello world'
  const actualMD5 = crypto.createHash('md5').update(payload).digest('base64')

  const server = await startServer((req, res) => {
    res.writeHead(200, {
      'content-md5': 'invalidhash==',
      'content-length': String(Buffer.byteLength(payload)),
    })
    res.end(payload)
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const origin = `http://127.0.0.1:${server.address().port}`

  const { body } = await request(origin, {
    verify: { hash: true },
    retry: false,
    trace: writer,
    dispatcher: makeDispatcher(t),
  })

  try {
    await body.text()
    t.fail('should have thrown')
  } catch (err) {
    t.match(err.message, /Content-MD5 mismatch/)
  }

  const docs = writer.docs.filter((doc) => doc.op === 'undici:verify')
  t.equal(docs.length, 1)

  const [doc] = docs
  t.equal(doc.kind, 'hash')
  t.equal(doc.expectedSize, null)
  t.equal(doc.actualSize, null)
  t.equal(doc.expectedHash, 'invalidhash==')
  t.equal(doc.actualHash, actualMD5)
  t.equal(doc.method, 'GET')
  t.equal(doc.url, `${origin}/`)
})

// ---------------------------------------------------------------------------
// body exceeding Content-Range mid-stream → kind 'overrun' (unit-level: the
// transport's content-length framing prevents a real server from overrunning)
// ---------------------------------------------------------------------------

test('trace-verify: overrun emits undici:verify doc with kind overrun', (t) => {
  const writer = makeWriter()

  let capturedError = null
  const fakeHandler = {
    onConnect() {},
    onHeaders() {
      return true
    },
    onData() {},
    onComplete() {},
    onError(err) {
      capturedError = err
    },
  }

  const fakeDispatch = (opts, handler) => {
    handler.onConnect(() => {})
    // content-range: bytes 0-1/2 means expected body = 2 bytes
    handler.onHeaders(206, { 'content-range': 'bytes 0-1/2', 'content-length': '2' }, () => {})
    handler.onData(Buffer.from('INJECTED_EXTRA')) // 14 bytes, exceeds 2
  }

  const dispatch = interceptors.responseVerify()(fakeDispatch)
  dispatch(
    {
      verify: { size: true },
      method: 'GET',
      origin: 'http://example.com',
      path: '/x',
      id: 'req-overrun',
      trace: writer,
    },
    fakeHandler,
  )

  t.match(capturedError?.message, /exceeded Content-Range/)

  const docs = writer.docs.filter((doc) => doc.op === 'undici:verify')
  t.equal(docs.length, 1)
  t.match(docs[0], {
    kind: 'overrun',
    expectedSize: 2,
    actualSize: 14,
    expectedHash: null,
    actualHash: null,
    id: 'req-overrun',
    method: 'GET',
    url: 'http://example.com/x',
  })

  t.end()
})
