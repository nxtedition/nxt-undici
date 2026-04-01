/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { request, dispatch } from '../lib/index.js'
import undici from '@nxtedition/undici'

test('simple request', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`)
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'asd')
  })
})

test('less simple request', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(
      `http://0.0.0.0:${server.address().port}/render/transcribe?file=Uw7DkpZcLDMLb4.json&start=&end=&engine=whisper&format=dpe&patchRecord=Uw66j3RLx0C3Rp%3Amedia.transcriptChanges&hash=323217f643c3e3f1fe7532e72ac01bb0748c97be`,
    )
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'asd')
  })
})

// ---------------------------------------------------------------------------
// opts.userAgent sets the user-agent request header (index.js line 126-128)
// ---------------------------------------------------------------------------

test('request: opts.userAgent sets user-agent header', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    t.equal(req.headers['user-agent'], 'my-test-agent/1.0', 'user-agent set from opts.userAgent')
    res.end()
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    await request(`http://0.0.0.0:${server.address().port}`, {
      userAgent: 'my-test-agent/1.0',
    })
  })
})

// ---------------------------------------------------------------------------
// opts.priority sets the nxt-priority request header (index.js line 130-132)
// ---------------------------------------------------------------------------

test('request: opts.priority sets nxt-priority header', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    t.ok(req.headers['nxt-priority'], 'nxt-priority header present when opts.priority set')
    res.end()
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    await request(`http://0.0.0.0:${server.address().port}`, {
      priority: 'high',
    })
  })
})

// ---------------------------------------------------------------------------
// globalThis.__nxt_undici_global_headers merges into every request (index.js 134-136)
// ---------------------------------------------------------------------------

test('request: globalThis.__nxt_undici_global_headers merged into request', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    t.equal(req.headers['x-global'], 'yes', 'global header merged into request')
    res.end()
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    globalThis.__nxt_undici_global_headers = { 'x-global': 'yes' }
    try {
      await request(`http://0.0.0.0:${server.address().port}`)
    } finally {
      delete globalThis.__nxt_undici_global_headers
    }
  })
})

// ---------------------------------------------------------------------------
// dispatch() export works like request() but uses the raw dispatch interface
// (index.js lines 178-180)
// ---------------------------------------------------------------------------

test('dispatch: export dispatches to a server and calls handler', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end('dispatched')
  })
  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const port = server.address().port
    const statusCode = await new Promise((resolve, reject) => {
      dispatch(
        undici.getGlobalDispatcher(),
        {
          origin: `http://0.0.0.0:${port}`,
          path: '/',
          method: 'GET',
        },
        {
          onConnect() {},
          onHeaders(sc) {
            resolve(sc)
            return true
          },
          onData() {},
          onComplete() {},
          onError: reject,
        },
      )
    })
    t.equal(statusCode, 200, 'dispatch() resolves via handler.onHeaders')
  })
})
