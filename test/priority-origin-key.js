import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const handler = {}

function capturingPriority() {
  const calls = []
  const dispatch = interceptors.priority()((opts, handler) => {
    calls.push({ opts, handler })
  })
  return { calls, dispatch }
}

test('priority: equivalent URL-like origins share one scheduler', (t) => {
  t.plan(3)
  const { calls, dispatch } = capturingPriority()

  dispatch(
    { origin: new URL('http://EXAMPLE.test:80/one'), headers: {}, priority: 'high' },
    handler,
  )
  dispatch({ origin: new URL('http://example.test/two'), headers: {}, priority: 'high' }, handler)
  dispatch(
    {
      origin: { protocol: 'http:', hostname: 'example.test', port: 80, pathname: '/three' },
      headers: {},
      priority: 'high',
    },
    handler,
  )

  t.equal(calls.length, 1, 'equivalent URL and URLObject values serialize together')
  calls[0].handler.onConnect(() => {})
  t.equal(calls.length, 2, 'the second equivalent origin runs after the first connects')
  calls[1].handler.onConnect(() => {})
  t.equal(calls.length, 3, 'the plain URLObject shares the same scheduler')
})

test('priority: rotating DNS addresses retain one scheme-aware logical key', (t) => {
  t.plan(2)
  const { calls, dispatch } = capturingPriority()
  const base = { headers: { host: 'service.test:8080' }, priority: 'high' }

  dispatch({ ...base, origin: 'http://192.0.2.1:8080' }, handler)
  dispatch({ ...base, origin: 'http://192.0.2.2:8080' }, handler)

  t.equal(calls.length, 1, 'same-scheme addresses for one logical Host serialize')
  calls[0].handler.onConnect(() => {})
  t.equal(calls.length, 2, 'the second address runs when the logical-origin slot is released')
})

test('priority: HTTP and HTTPS authorities use distinct schedulers', (t) => {
  t.plan(1)
  const { calls, dispatch } = capturingPriority()
  const base = { headers: { host: 'service.test:8080' }, priority: 'high' }

  dispatch({ ...base, origin: 'http://192.0.2.1:8080' }, handler)
  dispatch({ ...base, origin: 'https://192.0.2.2:8080' }, handler)

  t.equal(calls.length, 2, 'a shared Host does not conflate different schemes')
})

test('priority: equivalent OriginLike arrays share one scheduler', (t) => {
  t.plan(2)
  const { calls, dispatch } = capturingPriority()

  dispatch(
    {
      origin: [new URL('https://one.test/a'), { protocol: 'https:', hostname: 'two.test' }],
      headers: {},
      priority: 'high',
    },
    handler,
  )
  dispatch(
    {
      origin: [
        { protocol: 'https:', hostname: 'two.test', port: 443 },
        new URL('https://one.test/b'),
      ],
      headers: {},
      priority: 'high',
    },
    handler,
  )

  t.equal(calls.length, 1, 'equivalent origin pools canonicalize independent of value identity')
  calls[0].handler.onConnect(() => {})
  t.equal(calls.length, 2, 'the equivalent origin pool shares the scheduler')
})
