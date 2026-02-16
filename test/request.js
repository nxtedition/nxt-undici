/* eslint-disable */
import { test } from 'tap'
import { createServer } from 'node:http'
import { request } from '../lib/index.js'

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
