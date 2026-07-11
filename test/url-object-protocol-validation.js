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

test('parseURL validates host and hostname as authorities', (t) => {
  t.equal(
    parseURL({ protocol: 'http:', host: 'example.test:8080', path: '/' }).origin,
    'http://example.test:8080',
  )
  t.throws(
    () => parseURL({ protocol: 'http:', hostname: 'victim.test@attacker.test', path: '/' }),
    /Invalid URL authority/,
  )
  t.throws(
    () => parseURL({ protocol: 'http:', host: 'victim.test/path', path: '/' }),
    /Invalid URL authority/,
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

test('request rejects authority delimiters before dispatch', (t) => {
  let dispatches = 0
  const inner = () => {
    dispatches++
  }

  for (const url of [
    { protocol: 'http:', hostname: 'victim.test@attacker.test', path: '/' },
    { protocol: 'http:', host: 'victim.test/path', path: '/' },
  ]) {
    t.throws(() => request(inner, url), { code: 'UND_ERR_INVALID_ARG', message: 'invalid url' })
  }
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

test('default lookup rejects an injected object authority before dispatch', async (t) => {
  let dispatches = 0
  const { promise: error, resolve } = Promise.withResolvers()

  await dispatch(
    {
      dispatch() {
        dispatches++
      },
    },
    {
      origin: {
        protocol: 'http:',
        hostname: 'victim.test@attacker.test',
      },
      path: '/',
      method: 'GET',
      dns: false,
    },
    { onError: resolve },
  )

  t.match(await error, { message: 'Invalid URL authority' })
  t.equal(dispatches, 0)
})
