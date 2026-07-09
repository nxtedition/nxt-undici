/* eslint-disable */
// Node >= 26.3 bundles undici v8, which stores its global fetch dispatcher
// under Symbol.for('undici.globalDispatcher.2') — the same slot the
// @nxtedition/undici fork uses. When node's fetch machinery initializes first
// (tap's runtime does this), the slot holds node's built-in Agent, which
// rejects the fork's classic handler API with "invalid onRequestStart method".
// request() must not trust a foreign occupant of the shared slot.
import { test } from 'tap'
import { createServer } from 'node:http'
import { request, setGlobalDispatcher, Agent } from '../lib/index.js'

const SLOT = Symbol.for('undici.globalDispatcher.2')

test('request() ignores a foreign global dispatcher in the shared slot', async (t) => {
  t.plan(2)
  const server = createServer((req, res) => {
    res.end('via fallback')
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))

  const saved = globalThis[SLOT]
  t.teardown(() => {
    Object.defineProperty(globalThis, SLOT, { value: saved, writable: true })
  })
  // Simulate node's built-in undici v8 Agent occupying the slot: not a fork
  // Dispatcher, and its dispatch requires the new-style handler API.
  Object.defineProperty(globalThis, SLOT, {
    value: {
      dispatch() {
        throw new Error('invalid onRequestStart method')
      },
    },
    writable: true,
  })

  const { statusCode, body } = await request(`http://127.0.0.1:${server.address().port}/`)
  let text = ''
  for await (const chunk of body) {
    text += chunk
  }
  t.equal(statusCode, 200)
  t.equal(text, 'via fallback')
})

test('request() still honours a real fork dispatcher set as global', async (t) => {
  t.plan(2)
  const server = createServer((req, res) => {
    res.end('via real agent')
  })
  t.teardown(server.close.bind(server))
  server.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))

  const saved = globalThis[SLOT]
  const agent = new Agent()
  t.teardown(async () => {
    Object.defineProperty(globalThis, SLOT, { value: saved, writable: true })
    await agent.close()
  })

  let dispatched = 0
  const realDispatch = agent.dispatch.bind(agent)
  agent.dispatch = (opts, handler) => {
    dispatched++
    return realDispatch(opts, handler)
  }
  setGlobalDispatcher(agent)

  const { statusCode, body } = await request(`http://127.0.0.1:${server.address().port}/`)
  for await (const _ of body) {
  }
  t.equal(statusCode, 200)
  t.ok(dispatched >= 1, 'global fork agent was used')
})
