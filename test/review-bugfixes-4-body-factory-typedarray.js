import { test } from 'tap'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'

test('body factory with Uint8Array', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      res.end(Buffer.concat(chunks))
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: () => new Uint8Array([1, 2, 3]),
    })
    const chunks = []
    for await (const chunk of body) {
      chunks.push(chunk)
    }
    t.strictSame(Buffer.concat(chunks), Buffer.from([1, 2, 3]))
  })
})

test('body factory with DataView', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      res.end(Buffer.concat(chunks))
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: () => {
        const view = new DataView(new ArrayBuffer(4))
        view.setUint8(0, 0xde)
        view.setUint8(1, 0xad)
        view.setUint8(2, 0xbe)
        view.setUint8(3, 0xef)
        return view
      },
    })
    const chunks = []
    for await (const chunk of body) {
      chunks.push(chunk)
    }
    t.strictSame(Buffer.concat(chunks), Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  })
})

test('body factory with async Uint8Array', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      res.end(Buffer.concat(chunks))
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return new Uint8Array([4, 5, 6])
      },
    })
    const chunks = []
    for await (const chunk of body) {
      chunks.push(chunk)
    }
    t.strictSame(Buffer.concat(chunks), Buffer.from([4, 5, 6]))
  })
})

test('body factory with TypedArray view over larger buffer', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      res.end(Buffer.concat(chunks))
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: () => {
        // Subarray with non-zero byteOffset must send only its own bytes.
        const full = new Uint8Array([9, 9, 1, 2, 3, 9, 9])
        return full.subarray(2, 5)
      },
    })
    const chunks = []
    for await (const chunk of body) {
      chunks.push(chunk)
    }
    t.strictSame(Buffer.concat(chunks), Buffer.from([1, 2, 3]))
  })
})

test('body factory with ArrayBuffer', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      res.end(Buffer.concat(chunks))
    })
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const { body } = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'POST',
      body: () => Uint8Array.from([7, 8]).buffer,
    })
    const chunks = []
    for await (const chunk of body) {
      chunks.push(chunk)
    }
    t.strictSame(Buffer.concat(chunks), Buffer.from([7, 8]))
  })
})
