import { test } from 'tap'
import { dispatch, request } from '../lib/index.js'
import { parseURL } from '../lib/utils.js'

function makeDispatcher(capture) {
  return {
    dispatch(opts, handler) {
      capture(opts)
      handler.onConnect?.(() => {})
      handler.onHeaders?.(200, {}, () => {})
      handler.onComplete?.({})
      return true
    },
  }
}

async function captureRequest(url) {
  let captured
  const { body } = await request(url, {
    dispatch: makeDispatcher((opts) => {
      captured = opts
    }),
    dns: false,
    lookup(origin, _opts, callback) {
      callback(null, origin)
    },
  })
  await body.dump()
  return captured
}

test('plain URL objects bracket IPv6 hostnames consistently', async (t) => {
  const parsed = parseURL({ protocol: 'http:', hostname: '::1', port: 8080, path: '/' })
  t.equal(parsed.origin, 'http://[::1]:8080')

  const requestOpts = await captureRequest({
    protocol: 'http:',
    hostname: '::1',
    port: 8080,
    path: '/',
  })
  t.equal(requestOpts.origin, 'http://[::1]:8080')

  let dispatchOpts
  await dispatch(
    makeDispatcher((opts) => {
      dispatchOpts = opts
    }),
    {
      origin: { protocol: 'http:', hostname: '::1', port: 8080 },
      path: '/',
      method: 'GET',
      dns: false,
    },
    {},
  )
  t.equal(dispatchOpts.origin, 'http://[::1]:8080')
})

test('plain URL objects preserve an explicit port zero', async (t) => {
  const parsed = parseURL({
    protocol: 'http:',
    hostname: 'example.test',
    port: 0,
    path: '/',
  })
  t.equal(parsed.origin, 'http://example.test:0')

  const opts = await captureRequest({
    protocol: 'http:',
    host: '',
    hostname: 'example.test',
    port: 0,
    path: '/',
  })

  t.equal(opts.origin, 'http://example.test:0')

  let dispatchOpts
  await dispatch(
    makeDispatcher((innerOpts) => {
      dispatchOpts = innerOpts
    }),
    {
      origin: { protocol: 'http:', hostname: 'example.test', port: 0 },
      path: '/',
      method: 'GET',
      dns: false,
    },
    {},
  )
  t.equal(dispatchOpts.origin, 'http://example.test:0')
})
