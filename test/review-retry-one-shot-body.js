import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'tap'
import { request } from '../lib/index.js'

async function doesNotRetryOneShotBody(t, makeBody) {
  const requestBodies = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requestBodies.push(Buffer.concat(chunks).toString())
      if (requestBodies.length === 1) {
        res.writeHead(503)
        res.end('unavailable')
      } else {
        res.end('unexpected retry')
      }
    })
  })
  server.listen(0)
  await once(server, 'listening')
  t.teardown(server.close.bind(server))

  const response = await request(`http://127.0.0.1:${server.address().port}`, {
    method: 'PUT',
    body: makeBody(),
    error: false,
    retry: true,
  })

  t.equal(response.statusCode, 503, 'original response is returned instead of an empty-body retry')
  t.equal(await response.body.text(), 'unavailable')
  t.same(requestBodies, ['payload'], 'the consumed iterator was sent only once')
}

test('503 does not retry a consumed generator body as empty', async (t) => {
  await doesNotRetryOneShotBody(t, function* () {
    yield 'payload'
  })
})

test('503 does not retry a consumed async-generator body as empty', async (t) => {
  await doesNotRetryOneShotBody(t, async function* () {
    yield 'payload'
  })
})

test('503 does not retry an iterable that reuses one cached iterator', async (t) => {
  await doesNotRetryOneShotBody(t, () => {
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

test('503 does not retry an async iterable that reuses one cached iterator', async (t) => {
  await doesNotRetryOneShotBody(t, () => {
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

test('503 still retries a reusable iterable that also exposes next()', async (t) => {
  const requestBodies = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requestBodies.push(Buffer.concat(chunks).toString())
      if (requestBodies.length === 1) {
        res.writeHead(503)
        res.end('unavailable')
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
  const response = await request(`http://127.0.0.1:${server.address().port}`, {
    method: 'PUT',
    body: reusableBody,
    retry: true,
  })

  t.equal(response.statusCode, 200)
  t.equal(await response.body.text(), 'ok')
  t.same(requestBodies, ['payload', 'payload'], 'fresh iterator is replayed on retry')
})
