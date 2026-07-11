import { test } from 'tap'
import { interceptors } from '../lib/index.js'

const handler = {}

function capturingPressure() {
  const calls = []
  const pressure = interceptors.pressure({ sampleInterval: 0 })
  const dispatch = pressure((opts, handler) => {
    calls.push({ opts, handler })
  })
  return { calls, dispatch, pressure }
}

test('pressure: equivalent URL-like origins share one string-keyed record', (t) => {
  t.plan(4)
  const { calls, dispatch, pressure } = capturingPressure()
  t.teardown(() => pressure.close())

  dispatch({ origin: new URL('http://EXAMPLE.test:80/one') }, handler)
  dispatch({ origin: 'http://example.test/two' }, handler)
  dispatch(
    {
      origin: { protocol: 'http:', hostname: 'example.test', port: 80, pathname: '/three' },
    },
    handler,
  )

  t.equal(calls.length, 3, 'all requests reach the underlying dispatcher')
  t.equal(pressure.stats().length, 1, 'equivalent values do not fragment pressure state')
  t.match(pressure.stats('http://example.test'), { pending: 3 })
  t.same(
    pressure.stats().map(({ origin }) => origin),
    ['http://example.test'],
    'stats expose a canonical string rather than the first URL object',
  )
})

test('pressure: equivalent origin pools have one deterministic key', (t) => {
  t.plan(4)
  const { dispatch, pressure } = capturingPressure()
  t.teardown(() => pressure.close())

  dispatch(
    {
      origin: [new URL('https://two.test/a'), { protocol: 'https:', hostname: 'one.test' }],
    },
    handler,
  )
  dispatch(
    {
      origin: [
        { protocol: 'https:', hostname: 'one.test', port: 443, pathname: '/b' },
        new URL('https://two.test/c'),
        'https://one.test/d',
      ],
    },
    handler,
  )

  const key = JSON.stringify(['https://one.test', 'https://two.test'])
  const stats = pressure.stats()
  t.equal(stats.length, 1, 'order, value identity, and duplicate members do not fragment state')
  t.equal(stats[0].origin, key, 'the pool key has stable sorted serialization')
  t.type(stats[0].origin, 'string')
  t.match(pressure.stats(key), { pending: 2 })
})

test('pressure: scalar and singleton-pool origins share state without conflating protocols', (t) => {
  t.plan(4)
  const { dispatch, pressure } = capturingPressure()
  t.teardown(() => pressure.close())

  dispatch({ origin: 'http://service.test' }, handler)
  dispatch({ origin: [new URL('http://SERVICE.test:80/a')] }, handler)
  dispatch({ origin: 'https://service.test' }, handler)

  t.equal(pressure.stats().length, 2, 'HTTP and HTTPS retain separate pressure records')
  t.match(pressure.stats('http://service.test'), { pending: 2 })
  t.match(pressure.stats('https://service.test'), { pending: 1 })
  t.same(
    pressure
      .stats()
      .map(({ origin }) => origin)
      .toSorted(),
    ['http://service.test', 'https://service.test'],
  )
})
