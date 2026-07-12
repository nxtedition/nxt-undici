import * as undici from '@nxtedition/undici'
import { test } from 'tap'
import { Agent, Client, Pool, getGlobalDispatcher, setGlobalDispatcher } from '../lib/index.js'

test('transport exports match the runtime fork contract', async (t) => {
  t.equal(Client, undici.Client)
  t.equal(Pool, undici.Pool)
  t.equal(Agent, undici.Agent)
  t.equal(getGlobalDispatcher, undici.getGlobalDispatcher)
  t.equal(setGlobalDispatcher, undici.setGlobalDispatcher)

  const client = new Client('https://example.test', {
    tls: { rejectUnauthorized: false },
  })
  await client.close()

  t.throws(() => new Client('https://example.test', { allowH2: true }), {
    code: 'UND_ERR_INVALID_ARG',
  })
  t.throws(() => new Client('https://example.test', { maxConcurrentStreams: 12 }), {
    code: 'UND_ERR_INVALID_ARG',
  })
})
