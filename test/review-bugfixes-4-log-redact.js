import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { inspect } from 'node:util'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

async function startServer(handler) {
  const server = createServer(handler ?? ((req, res) => res.end('ok')))
  server.listen(0)
  await once(server, 'listening')
  return server
}

// Stub logger that captures both child() bindings and every log record so we
// can assert on exactly what would end up in pino output.
function makeCapturingLogger() {
  const bindings = []
  const records = []
  function makeChild() {
    return {
      bindings,
      records,
      debug(...args) {
        records.push({ level: 'debug', args })
      },
      warn(...args) {
        records.push({ level: 'warn', args })
      },
      error(...args) {
        records.push({ level: 'error', args })
      },
      child(b) {
        bindings.push(b)
        return makeChild()
      },
    }
  }
  return makeChild()
}

function rawRequest(dispatch, opts) {
  return new Promise((resolve, reject) => {
    let statusCode
    dispatch(opts, {
      onConnect() {},
      onHeaders(sc) {
        statusCode = sc
        return true
      },
      onData() {},
      onComplete() {
        resolve(statusCode)
      },
      onError: reject,
    })
  })
}

// Everything the stub logger ever saw, flattened to a string, so we can assert
// a secret value is not present anywhere (bindings or log records).
function capturedText(logger) {
  return inspect({ bindings: logger.bindings, records: logger.records }, { depth: 20 })
}

// ---------------------------------------------------------------------------
// Request credentials and body content must not reach the logger
// ---------------------------------------------------------------------------

test('log: authorization/cookie header values and body content are not logged', async (t) => {
  const server = await startServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200)
      res.end()
    })
  })
  t.teardown(server.close.bind(server))

  const logger = makeCapturingLogger()
  const dispatch = compose(new undici.Agent(), interceptors.log())
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'POST',
    headers: {
      Authorization: 'Bearer top-secret-token',
      Cookie: 'session=super-secret-cookie',
      'x-plain': 'visible-value',
    },
    body: 'this-body-is-confidential',
    logger,
  })
  t.equal(status, 200)

  const ureq = logger.bindings[0]?.ureq
  t.ok(ureq, 'child() was called with a ureq binding')
  t.equal(ureq.headers.authorization, '[redacted]', 'authorization redacted (case-insensitive)')
  t.equal(ureq.headers.cookie, '[redacted]', 'cookie redacted (case-insensitive)')
  t.equal(ureq.headers['x-plain'], 'visible-value', 'non-secret headers preserved')
  t.equal(ureq.method, 'POST')
  t.equal(ureq.path, '/')
  t.match(ureq.body, /^string\(\d+ bytes\)$/, 'body summarized as type + byte length')

  const text = capturedText(logger)
  t.notMatch(text, /top-secret-token/, 'authorization value absent from all captured logs')
  t.notMatch(text, /super-secret-cookie/, 'cookie value absent from all captured logs')
  t.notMatch(text, /this-body-is-confidential/, 'body content absent from all captured logs')
})

// ---------------------------------------------------------------------------
// 5xx error-level record: ureq redacted, response set-cookie redacted
// ---------------------------------------------------------------------------

test('log: 5xx error record redacts request credentials and response set-cookie', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(500, { 'Set-Cookie': 'session=server-secret', 'x-plain': 'visible-value' })
    res.end()
  })
  t.teardown(server.close.bind(server))

  const logger = makeCapturingLogger()
  const dispatch = compose(new undici.Agent(), interceptors.log())
  await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { authorization: 'Bearer top-secret-token' },
    logger,
  })

  const errorRecord = logger.records.find(
    (r) => r.level === 'error' && String(r.args[r.args.length - 1]).includes('completed'),
  )
  t.ok(errorRecord, 'error was logged for 5xx response')

  const data = errorRecord.args[0]
  t.equal(data.ureq.headers.authorization, '[redacted]', 'authorization redacted in error record')
  t.equal(data.ures.headers['set-cookie'], '[redacted]', 'set-cookie redacted in error record')
  t.equal(data.ures.headers['x-plain'], 'visible-value', 'non-secret response headers preserved')
  t.equal(data.ures.statusCode, 500)

  const text = capturedText(logger)
  t.notMatch(text, /top-secret-token/, 'authorization value absent from all captured logs')
  t.notMatch(text, /server-secret/, 'set-cookie value absent from all captured logs')
})

// ---------------------------------------------------------------------------
// Buffer body summarized, flat-array request headers redacted too
// ---------------------------------------------------------------------------

test('log: buffer body is summarized and flat-array headers are redacted', async (t) => {
  const server = await startServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200)
      res.end()
    })
  })
  t.teardown(server.close.bind(server))

  const logger = makeCapturingLogger()
  const dispatch = compose(new undici.Agent(), interceptors.log())
  const body = Buffer.from('buffer-body-secret-payload')
  const status = await rawRequest(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'POST',
    headers: ['Proxy-Authorization', 'Basic dXNlcjpwYXNz', 'x-plain', 'visible-value'],
    body,
    logger,
  })
  t.equal(status, 200)

  const ureq = logger.bindings[0]?.ureq
  t.ok(ureq, 'child() was called with a ureq binding')
  t.equal(ureq.headers['proxy-authorization'], '[redacted]', 'proxy-authorization redacted')
  t.equal(ureq.headers['x-plain'], 'visible-value', 'non-secret headers preserved')
  t.equal(ureq.body, `Buffer(${body.byteLength} bytes)`, 'buffer body summarized, not embedded')

  const text = capturedText(logger)
  t.notMatch(text, /dXNlcjpwYXNz/, 'proxy-authorization value absent from all captured logs')
  t.notMatch(text, /buffer-body-secret-payload/, 'buffer content absent from all captured logs')
})
