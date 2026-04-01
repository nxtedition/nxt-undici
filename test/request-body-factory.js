/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { request } from '../lib/index.js'

test('body factory with string', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.end(body)
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: () => 'hello from factory',
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'hello from factory')
  })
})

test('body factory with Buffer', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.end(body)
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: () => Buffer.from('buffer body'),
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'buffer body')
  })
})

test('body factory with async function', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.end(body)
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: async () => 'async body',
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'async body')
  })
})

test('body factory returning a Readable stream', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.end(body)
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: () => Readable.from(['hello', ' from', ' stream']),
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'hello from stream')
  })
})

test('body factory returning an async generator (iterable path)', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.end(body)
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      // async generator → Readable.from() path (not isStream)
      body: async function* () {
        yield 'hello'
        yield ' from generator'
      },
    })
    let str = ''
    for await (const chunk of body) {
      str += chunk
    }
    t.equal(str, 'hello from generator')
  })
})

test('body factory that rejects — request fails with factory error', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.end()
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    try {
      await request(`http://0.0.0.0:${server.address().port}`, {
        method: 'POST',
        body: () => Promise.reject(new Error('factory rejected')),
      })
      t.fail('should have thrown')
    } catch (err) {
      t.match(err.message, /factory rejected/, 'rejection error propagated')
    }
  })
})

test('body factory receives abort signal', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.end(body)
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    let receivedSignal = null
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: ({ signal }) => {
        receivedSignal = signal
        return 'body'
      },
    })
    for await (const _ of body) {
      // drain
    }
    t.ok(receivedSignal instanceof AbortSignal, 'factory receives AbortSignal')
  })
})

test('body factory aborted before resolving — stream destroys and request fails', (t) => {
  // Tests FactoryStream._destroy with this.#ac set (destroyed before construct resolves).
  t.plan(1)
  const server = createServer((req, res) => {
    res.end()
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const ac = new AbortController()
    // Factory blocks indefinitely — never resolves.
    let factoryStarted = false
    try {
      const reqPromise = request(`http://0.0.0.0:${server.address().port}`, {
        method: 'POST',
        body: ({ signal }) => {
          factoryStarted = true
          // Abort the outer request while the factory is pending.
          setImmediate(() => ac.abort(new Error('aborted early')))
          return new Promise(() => {}) // never resolves
        },
        signal: ac.signal,
      })
      await reqPromise
      t.fail('should have thrown')
    } catch (err) {
      t.ok(factoryStarted && err, 'request aborted while factory pending')
    }
  })
})
