import { test } from 'tap'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { request, dispatch, Agent } from '../lib/index.js'

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
// followed 302 hop emits exactly one undici:redirect doc
// ---------------------------------------------------------------------------

test('trace: followed 302 emits one undici:redirect doc', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/a') {
      res.writeHead(302, { location: '/b' })
      res.end()
    } else {
      res.end('ok')
    }
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const origin = `http://127.0.0.1:${server.address().port}`

  const { body, statusCode } = await request(`${origin}/a`, {
    trace: writer,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()
  t.equal(statusCode, 200)

  const redirects = writer.docs.filter((doc) => doc.op === 'undici:redirect')
  t.equal(redirects.length, 1)

  const [redirect] = redirects
  t.equal(redirect.statusCode, 302)
  t.equal(redirect.method, 'GET')
  t.ok(redirect.from.endsWith('/a'))
  t.ok(redirect.to.endsWith('/b'))
  t.type(redirect.count, 'number')

  const start = writer.docs.find((doc) => doc.op === 'undici:request' && doc.phase === 'start')
  t.ok(start)
  t.equal(redirect.id, start.id)
})

// ---------------------------------------------------------------------------
// 303 rewrites POST to GET for the next hop
// ---------------------------------------------------------------------------

test('trace: 303 doc carries the post-rewrite GET method', async (t) => {
  const server = await startServer((req, res) => {
    req.resume()
    if (req.url === '/a') {
      res.writeHead(303, { location: '/b' })
      res.end()
    } else {
      res.end('ok')
    }
  })
  t.teardown(server.close.bind(server))

  const writer = makeWriter()
  const origin = `http://127.0.0.1:${server.address().port}`

  const { body, statusCode } = await request(`${origin}/a`, {
    method: 'POST',
    body: 'REQUEST',
    trace: writer,
    dispatcher: makeDispatcher(t),
  })
  await body.dump()
  t.equal(statusCode, 200)

  const redirects = writer.docs.filter((doc) => doc.op === 'undici:redirect')
  t.equal(redirects.length, 1)
  t.equal(redirects[0].statusCode, 303)
  t.equal(redirects[0].method, 'GET')
  t.ok(redirects[0].from.endsWith('/a'))
  t.ok(redirects[0].to.endsWith('/b'))
})

test('trace: redirect source keeps the request origin spelling', async (t) => {
  const writer = makeWriter()
  let attempt = 0
  const dispatcher = {
    dispatch(opts, handler) {
      attempt++
      handler.onConnect(() => {})
      if (attempt === 1) {
        handler.onHeaders(302, { location: '/b' }, () => {})
      } else {
        handler.onHeaders(200, {}, () => {})
      }
      handler.onComplete({})
    },
  }

  await new Promise((resolve, reject) => {
    Promise.resolve(
      dispatch(
        dispatcher,
        {
          origin: 'http://LOCALHOST:80',
          path: '/a',
          follow: 1,
          dns: false,
          trace: writer,
        },
        {
          onConnect() {},
          onHeaders() {},
          onComplete: resolve,
          onError: reject,
        },
      ),
    ).catch(reject)
  })

  const start = writer.docs.find((doc) => doc.op === 'undici:request' && doc.phase === 'start')
  const redirect = writer.docs.find((doc) => doc.op === 'undici:redirect')
  t.equal(start.url, 'http://LOCALHOST:80/a')
  t.equal(redirect.from, start.url)
})
