import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { compose, interceptors } from '../lib/index.js'
import undici from '@nxtedition/undici'

// Regression tests: the dispatch-time request-header accumulator in
// lib/interceptor/proxy.js must strip `content-length` (on non-payload
// methods) and `expect` case-insensitively. The production pipeline
// lowercases keys via parseHeaders first, but the standalone
// interceptors.proxy() composition passes user headers through verbatim, so
// mixed-case `Content-Length` / `Expect` used to leak into undici, which
// rejects them (e.g. NotSupportedError for expect).

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0)
  await once(server, 'listening')
  return server
}

function makeDispatch() {
  return compose(new undici.Agent(), interceptors.proxy())
}

function requestViaDispatch(dispatch, opts) {
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

test('proxy: mixed-case Content-Length is stripped on GET (standalone composition)', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    t.notOk(req.headers['content-length'], 'content-length stripped from GET')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const statusCode = await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { 'Content-Length': '0' },
    proxy: {},
  })
  t.equal(statusCode, 200, 'request completes')
})

test('proxy: mixed-case Expect is stripped (standalone composition)', async (t) => {
  t.plan(2)
  const server = await startServer((req, res) => {
    t.notOk(req.headers['expect'], 'expect header stripped')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const statusCode = await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { Expect: '100-continue' },
    proxy: {},
  })
  t.equal(statusCode, 200, 'request completes without NotSupportedError')
})

test('proxy: lowercase content-length and expect keep being stripped', async (t) => {
  t.plan(3)
  const server = await startServer((req, res) => {
    t.notOk(req.headers['content-length'], 'content-length stripped from GET')
    t.notOk(req.headers['expect'], 'expect header stripped')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  const statusCode = await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'GET',
    headers: { 'content-length': '0', expect: '100-continue' },
    proxy: {},
  })
  t.equal(statusCode, 200, 'request completes')
})

test('proxy: mixed-case Content-Length is preserved on POST (payload method)', async (t) => {
  t.plan(1)
  const server = await startServer((req, res) => {
    t.equal(req.headers['content-length'], '5', 'content-length preserved on POST')
    res.end()
  })
  t.teardown(server.close.bind(server))

  const dispatch = makeDispatch()
  await requestViaDispatch(dispatch, {
    origin: `http://127.0.0.1:${server.address().port}`,
    path: '/',
    method: 'POST',
    headers: { 'Content-Length': '5' },
    body: 'hello',
    proxy: {},
  })
})
