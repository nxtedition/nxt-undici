import { test } from 'tap'
import { dispatch } from '../lib/index.js'
import { request } from '../lib/request.js'
import { parseURL } from '../lib/utils.js'

test('parseURL rejects protocol-like URL object values', (t) => {
  t.throws(
    () => parseURL({ protocol: 'http:attacker.test', hostname: 'victim.test', path: '/' }),
    /Invalid URL protocol/,
  )
  t.throws(
    () => parseURL({ protocol: 'https:attacker.test', hostname: 'victim.test', path: '/' }),
    /Invalid URL protocol/,
  )
  t.end()
})

test('request rejects a malformed object protocol before dispatch', (t) => {
  let dispatches = 0

  t.throws(
    () =>
      request(
        () => {
          dispatches++
        },
        {
          protocol: 'http:attacker.test',
          hostname: 'victim.test',
          path: '/',
        },
      ),
    { code: 'UND_ERR_INVALID_ARG', message: 'invalid url' },
  )
  t.equal(dispatches, 0)
  t.end()
})

test('default lookup rejects a malformed object protocol before the dispatcher boundary', async (t) => {
  let dispatches = 0
  const dispatcher = {
    dispatch() {
      dispatches++
    },
  }
  const { promise: error, resolve } = Promise.withResolvers()

  await dispatch(
    dispatcher,
    {
      origin: {
        protocol: 'http:attacker.test',
        hostname: 'victim.test',
      },
      path: '/',
      method: 'GET',
      dns: false,
    },
    {
      onError: resolve,
    },
  )

  t.match(await error, { message: 'invalid url' })
  t.equal(dispatches, 0)
})
