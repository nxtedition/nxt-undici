import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'tap'
import { request } from '../lib/index.js'

async function rejectsOneShotBody(t, makeBody) {
  const requestBodies = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requestBodies.push(Buffer.concat(chunks).toString())
      if (req.url === '/start') {
        res.writeHead(307, { location: '/redirected' })
        res.end()
      } else {
        res.end('unexpected second request')
      }
    })
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  await t.rejects(
    request(`http://127.0.0.1:${server.address().port}/start`, {
      method: 'POST',
      body: makeBody(),
      retry: false,
      follow: 2,
    }),
    /Disturbed request cannot be redirected/,
  )

  t.same(requestBodies, ['payload'], 'redirect did not replay the consumed iterator as empty')
}

test('307 rejects a consumed generator body instead of replaying an empty body', async (t) => {
  await rejectsOneShotBody(t, function* () {
    yield 'payload'
  })
})

test('307 rejects a consumed async-generator body instead of replaying an empty body', async (t) => {
  await rejectsOneShotBody(t, async function* () {
    yield 'payload'
  })
})

test('307 rejects an iterable that reuses one cached iterator', async (t) => {
  await rejectsOneShotBody(t, () => {
    const iterator = (function* () {
      yield 'payload'
    })()
    return {
      [Symbol.iterator]() {
        return iterator
      },
    }
  })
})

test('307 rejects an async iterable that reuses one cached iterator', async (t) => {
  await rejectsOneShotBody(t, () => {
    const iterator = (async function* () {
      yield 'payload'
    })()
    return {
      [Symbol.asyncIterator]() {
        return iterator
      },
    }
  })
})

test('follow callback can veto redirect of a consumed generator body', async (t) => {
  const requestBodies = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requestBodies.push(Buffer.concat(chunks).toString())
      res.writeHead(307, { location: '/not-followed' })
      res.end('redirect response')
    })
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const response = await request(`http://127.0.0.1:${server.address().port}/start`, {
    method: 'POST',
    body: (function* () {
      yield 'payload'
    })(),
    retry: false,
    follow: () => false,
  })

  t.equal(response.statusCode, 307)
  t.equal(await response.body.text(), 'redirect response')
  t.same(requestBodies, ['payload'], 'veto avoids replaying the consumed generator')
})

test('307 still replays a reusable iterable that also exposes next()', async (t) => {
  const requestBodies = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requestBodies.push(Buffer.concat(chunks).toString())
      if (req.url === '/start') {
        res.writeHead(307, { location: '/redirected' })
        res.end()
      } else {
        res.end('ok')
      }
    })
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const reusableBody = {
    next() {
      return { done: true }
    },
    *[Symbol.iterator]() {
      yield 'payload'
    },
  }
  const response = await request(`http://127.0.0.1:${server.address().port}/start`, {
    method: 'POST',
    body: reusableBody,
    retry: false,
    follow: 2,
  })

  t.equal(response.statusCode, 200)
  t.equal(await response.body.text(), 'ok')
  t.same(requestBodies, ['payload', 'payload'], 'fresh iterator is replayed on the second hop')
})
