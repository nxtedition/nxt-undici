import { test } from 'tap'
import { dispatch } from '../lib/index.js'

async function capture(extra) {
  let captured
  const dispatcher = {
    dispatch(opts, handler) {
      captured = opts
      handler.onConnect?.(() => {})
      handler.onHeaders?.(200, {}, () => {})
      handler.onComplete?.({})
      return true
    },
  }

  await dispatch(
    dispatcher,
    {
      origin: 'http://example.test',
      path: '/',
      method: 'GET',
      dns: false,
      lookup: false,
      ...extra,
    },
    {},
  )
  return captured
}

test('header-derived priority also controls socket type of service', async (t) => {
  const scalar = await capture({ headers: { 'nxt-priority': 'high' } })
  t.equal(scalar.priority, 'high')
  t.equal(scalar.typeOfService, 0x68)

  const repeated = await capture({ headers: { 'nxt-priority': ['low', 'higher'] } })
  t.equal(repeated.priority, 'higher')
  t.equal(repeated.typeOfService, 0x88)

  const overridden = await capture({
    headers: { 'nxt-priority': 'high' },
    typeOfService: 7,
  })
  t.equal(overridden.typeOfService, 7)
})

test('unknown priority names cannot read inherited type-of-service values', async (t) => {
  for (const priority of ['constructor', 'toString', '__proto__']) {
    const opts = await capture({ priority })
    t.equal(opts.priority, priority)
    t.equal(opts.typeOfService, 0, `${priority} falls back to best effort`)
  }
})
