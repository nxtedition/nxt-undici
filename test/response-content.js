import { test } from 'tap'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'
import { Readable } from 'node:stream'

test('put & Readable', (t) => {
  t.plan(1)

  const server = createServer(async (req, res) => {
    res.flushHeaders()
    req.resume()
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const _err = new Error('asd')
    const body = await request(`http://0.0.0.0:${server.address().port}`, {
      method: 'PUT',
      body: async function () {
        const src = new Readable({ read() {} })
        setTimeout(() => {
          src.destroy(_err)
        }, 100)
        src.push('asd')
        return src
      },
    })
    try {
      await body.text()
      t.fail()
    } catch (err) {
      t.same(err, _err)
    }
  })
})

test('get', (t) => {
  t.plan(1)

  const server = createServer((req, res) => {
    req.resume()
    res.setHeader('content-md5', 'asd')
    res.end('asd')
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const port = server.address().port
    try {
      const body = await request(`http://0.0.0.0:${port}`, {
        method: 'GET',
      })
      await body.text()
    } catch (err) {
      t.ok(err)
    }
  })
})

test('put & get', (t) => {
  t.plan(1)

  const server = createServer((req, res) => {
    req.resume()
    if (req.method === 'GET') {
      res.setHeader('content-md5', 'asd')
      res.write('asd')
      setTimeout(() => {
        res.end('asd')
      }, 200)
    } else {
      res.flushHeaders()
    }
  })

  t.teardown(server.close.bind(server))
  server.listen(0, async () => {
    const port = server.address().port
    const body = await request(`http://0.0.0.0:${port}`, {
      method: 'PUT',
      body: async function () {
        return await request(`http://0.0.0.0:${port}`)
      },
    })
    try {
      await body.text()
      t.fail()
    } catch (err) {
      t.ok(err)
    }
  })
})
