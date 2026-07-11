import vm from 'node:vm'
import { test } from 'tap'
import requestBodyFactory from '../lib/interceptor/request-body-factory.js'

test('body factory accepts an ArrayBuffer from another realm', async (t) => {
  const foreign = vm.runInNewContext('Uint8Array.from([0x66, 0x6f, 0x6f]).buffer')
  t.notOk(foreign instanceof ArrayBuffer, 'fixture has a foreign ArrayBuffer prototype')

  let body
  const dispatch = requestBodyFactory()((opts) => {
    body = opts.body
  })
  dispatch({ body: () => foreign }, {})

  const chunks = []
  for await (const chunk of body) {
    chunks.push(chunk)
  }
  t.equal(Buffer.concat(chunks).toString(), 'foo')
})
