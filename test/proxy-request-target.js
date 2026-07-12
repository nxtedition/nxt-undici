import { test } from 'tap'
import { dispatch as dispatchRequest } from '../lib/index.js'

const BAD_REQUEST = {
  message: 'Unsupported request target',
  statusCode: 400,
  expose: true,
}

const BASE_OPTIONS = {
  origin: 'http://configured.invalid',
  path: '/',
  method: 'GET',
  headers: {},
  cache: false,
  dns: false,
  error: false,
  follow: false,
  lookup: false,
  retry: false,
  verify: false,
}

function run(dispatcher, overrides) {
  return new Promise((resolve, reject) => {
    let statusCode
    let headers
    let result

    try {
      result = dispatchRequest(
        dispatcher,
        { ...BASE_OPTIONS, ...overrides },
        {
          onConnect() {},
          onHeaders(code, value) {
            statusCode = code
            headers = value
            return true
          },
          onData() {},
          onComplete() {
            resolve({ statusCode, headers })
          },
          onError: reject,
        },
      )
    } catch (err) {
      reject(err)
      return
    }

    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      Promise.resolve(result).catch(reject)
    }
  })
}

async function capture(overrides) {
  let captured
  await run((opts, handler) => {
    captured = opts
    handler.onConnect(() => {})
    handler.onHeaders(204, {}, () => {})
    handler.onComplete({})
    return true
  }, overrides)
  return captured
}

test('proxy target: own parsed target reduces absolute-form to path and query', async (t) => {
  const captured = await capture({
    path: 'HTTP://untrusted.invalid/absolute/path?foo=bar',
    proxy: {
      requestTarget: { pathname: '/absolute/path', search: '?foo=bar' },
    },
  })

  t.equal(captured.origin, 'http://configured.invalid')
  t.equal(captured.path, '/absolute/path?foo=bar')
})

test('proxy target: safe origin-form wins without inspecting parsed target fields', async (t) => {
  const captured = await capture({
    path: '/safe/path?foo=bar',
    proxy: {
      requestTarget: { pathname: '//ignored.invalid', search: 42 },
    },
  })

  t.equal(captured.path, '/safe/path?foo=bar')
  t.notOk(Object.hasOwn(captured.proxy, 'requestTarget'), 'one-shot metadata is consumed')
})

test('proxy target: consumption does not mutate the caller proxy object', async (t) => {
  const requestTarget = { pathname: '/resource', search: null }
  const proxy = {
    name: 'edge',
    originBoundHeaders: ['nxt-user-id'],
    requestTarget,
  }

  const captured = await capture({
    path: 'http://untrusted.invalid/resource',
    proxy,
  })

  t.equal(proxy.requestTarget, requestTarget)
  t.ok(Object.hasOwn(proxy, 'requestTarget'), 'caller metadata remains present')
  t.not(captured.proxy, proxy, 'the internal proxy options are isolated')
  t.notOk(Object.hasOwn(captured.proxy, 'requestTarget'), 'internal metadata is consumed')
  t.same(captured.proxy.originBoundHeaders, ['nxt-user-id'])
  t.equal(captured.proxy.name, 'edge')
})

test('proxy target: an inherited requestTarget is ignored', async (t) => {
  const inherited = { pathname: '/forged', search: '?forged=1' }
  const proxy = Object.assign(Object.create({ requestTarget: inherited }), { name: 'edge' })
  const path = 'http://untrusted.invalid/original?value=1'

  const captured = await capture({ path, proxy })

  t.equal(captured.path, path)
  t.equal(captured.proxy, proxy)
  t.notOk(Object.hasOwn(captured.proxy, 'requestTarget'))
  t.equal(captured.proxy.requestTarget, inherited, 'prototype metadata was not consumed or trusted')
})

test('proxy target: proxy requests without own metadata retain legacy path behavior', async (t) => {
  const paths = [
    'http://untrusted.invalid/absolute?value=1',
    '//untrusted.invalid/network?value=1',
    '/\\untrusted.invalid/backslash?value=1',
    '*',
  ]

  for (const path of paths) {
    const captured = await capture({ path, proxy: { name: 'edge' } })
    t.equal(captured.path, path, path)
  }
})

test('proxy target: invalid own-target combinations fail as exposed client errors', async (t) => {
  const cases = [
    {
      name: 'network-path request target',
      path: '//untrusted.invalid/network',
      requestTarget: { pathname: '/network', search: '' },
    },
    {
      name: 'slash-backslash request target',
      path: '/\\untrusted.invalid/backslash',
      requestTarget: { pathname: '/backslash', search: '' },
    },
    {
      name: 'asterisk-form request target',
      path: '*',
      requestTarget: { pathname: '/', search: '' },
    },
    {
      name: 'unsupported absolute scheme',
      path: 'ftp://untrusted.invalid/resource',
      requestTarget: { pathname: '/resource', search: '' },
    },
    {
      name: 'missing parsed target',
      path: 'http://untrusted.invalid/resource',
      requestTarget: null,
    },
    {
      name: 'ambiguous parsed pathname',
      path: 'http://untrusted.invalid//network',
      requestTarget: { pathname: '//network', search: '' },
    },
    {
      name: 'non-string parsed search',
      path: 'http://untrusted.invalid/resource',
      requestTarget: { pathname: '/resource', search: 42 },
    },
    {
      name: 'non-string raw path',
      path: Symbol('request target'),
      requestTarget: { pathname: '/resource', search: '' },
    },
  ]

  for (const { name, path, requestTarget } of cases) {
    await t.rejects(capture({ path, proxy: { requestTarget } }), BAD_REQUEST, name)
  }
})

test('proxy target: query serialization runs after absolute-form canonicalization', async (t) => {
  const captured = await capture({
    path: 'http://untrusted.invalid/search',
    query: { q: 'test', page: 2 },
    proxy: {
      requestTarget: { pathname: '/search', search: null },
    },
  })

  t.equal(captured.path, '/search?q=test&page=2')
})

test('proxy target: cache and log observe the canonical path', async (t) => {
  const cachePaths = []
  let loggedPath
  const logger = {
    child(bindings) {
      loggedPath = bindings.ureq.path
      return this
    },
    debug() {},
    error() {},
    info() {},
    warn() {},
  }

  await capture({
    path: 'http://untrusted.invalid/canonical?value=1',
    proxy: {
      requestTarget: { pathname: '/canonical', search: '?value=1' },
    },
    cache: {
      store: {
        get(key) {
          cachePaths.push(key.path)
        },
        set() {},
      },
    },
    logger,
  })

  t.same(cachePaths, ['/canonical?value=1'])
  t.equal(loggedPath, '/canonical?value=1')
})

test('proxy target: parsed metadata is not reapplied to redirect paths', async (t) => {
  const attempts = []
  const dispatcher = (opts, handler) => {
    attempts.push(opts.path)
    handler.onConnect(() => {})
    if (attempts.length === 1) {
      handler.onHeaders(
        302,
        { location: 'http://configured.invalid//redirect-generated/path' },
        () => {},
      )
    } else {
      handler.onHeaders(204, {}, () => {})
    }
    handler.onComplete({})
    return true
  }

  await run(dispatcher, {
    path: 'http://untrusted.invalid/start',
    follow: 2,
    proxy: {
      requestTarget: { pathname: '/start', search: null },
    },
  })

  t.same(attempts, ['/start', '//redirect-generated/path'])
})

test('proxy target: parsed metadata is not reapplied to retry mutations', async (t) => {
  const attempts = []
  let retryCalls = 0
  const dispatcher = (opts, handler) => {
    attempts.push(opts.path)
    handler.onConnect(() => {})
    if (attempts.length === 1) {
      handler.onError(Object.assign(new Error('retry me'), { code: 'ECONNRESET' }))
    } else {
      handler.onHeaders(204, {}, () => {})
      handler.onComplete({})
    }
    return true
  }

  await run(dispatcher, {
    path: 'http://untrusted.invalid/start',
    proxy: {
      requestTarget: { pathname: '/start', search: null },
    },
    retry(err, retryCount, opts) {
      retryCalls++
      t.equal(err.code, 'ECONNRESET')
      t.equal(retryCount, 0)
      t.equal(opts.path, '/start')
      t.notOk(Object.hasOwn(opts.proxy, 'requestTarget'))
      opts.path = '/retry-generated/path'
      return true
    },
  })

  t.equal(retryCalls, 1)
  t.same(attempts, ['/start', '/retry-generated/path'])
})
