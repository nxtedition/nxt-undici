import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function cloneHeaders(headers) {
  if (Array.isArray(headers)) {
    return [...headers]
  }

  return headers && typeof headers === 'object' ? { ...headers } : headers
}

function lowerCaseHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  )
}

function runRedirect(responses, opts) {
  const attempts = []
  let responseIndex = 0

  const base = (currentOpts, handler) => {
    const response = responses[responseIndex++]
    if (response == null) {
      throw new Error(`Unexpected redirect attempt ${responseIndex}`)
    }

    attempts.push({ ...currentOpts, headers: cloneHeaders(currentOpts.headers) })
    handler.onConnect?.(() => {})
    handler.onHeaders?.(response.statusCode, response.headers ?? {}, () => {})
    handler.onComplete?.({})
    return true
  }

  const dispatch = compose(base, interceptors.redirect())
  return new Promise((resolve, reject) => {
    let statusCode

    try {
      dispatch(opts, {
        onConnect() {},
        onHeaders(nextStatusCode) {
          statusCode = nextStatusCode
          return true
        },
        onData() {},
        onComplete() {
          resolve({ attempts, statusCode })
        },
        onError: reject,
      })
    } catch (err) {
      reject(err)
    }
  })
}

const sensitiveHeaders = {
  Authorization: 'Bearer client-token',
  Cookie: 'session=client-cookie',
  'Nxt-User-Id': 'trusted-user',
  'Proxy-Authorization': 'Basic proxy-token',
  'X-Preserved': 'yes',
}

const sensitiveHeaderArray = Object.entries(sensitiveHeaders).flat()

for (const { createHeaders, label } of [
  { createHeaders: () => ({ ...sensitiveHeaders }), label: 'object replacement' },
  { createHeaders: () => [...sensitiveHeaderArray], label: 'flat-array replacement' },
]) {
  test(`cross-origin redirect strips mandatory and custom headers after ${label}`, async (t) => {
    const result = await runRedirect(
      [
        { statusCode: 302, headers: { location: '/final' } },
        { statusCode: 200, headers: {} },
      ],
      {
        origin: 'http://source.test',
        path: '/first',
        method: 'GET',
        headers: {},
        proxy: { originBoundHeaders: ['NXT-USER-ID'] },
        follow(location, count, opts) {
          t.equal(location, '/final')
          t.equal(count, 1)
          t.equal(this, opts)
          opts.origin = 'http://destination.test'
          opts.headers = createHeaders()
          return true
        },
      },
    )

    const redirectedHeaders = lowerCaseHeaders(result.attempts[1].headers)
    t.equal(result.statusCode, 200)
    t.notOk(redirectedHeaders.authorization)
    t.notOk(redirectedHeaders['proxy-authorization'])
    t.notOk(redirectedHeaders.cookie)
    t.notOk(redirectedHeaders['nxt-user-id'])
    t.equal(redirectedHeaders['x-preserved'], 'yes')
  })
}

test('same-origin redirect preserves a configured origin-bound header', async (t) => {
  const result = await runRedirect(
    [
      { statusCode: 302, headers: { location: '/final' } },
      { statusCode: 200, headers: {} },
    ],
    {
      origin: 'http://source.test',
      path: '/first',
      method: 'GET',
      headers: {
        authorization: 'Bearer client-token',
        'nxt-user-id': 'trusted-user',
      },
      proxy: { originBoundHeaders: ['nxt-user-id'] },
      follow: 1,
    },
  )

  const redirectedHeaders = lowerCaseHeaders(result.attempts[1].headers)
  t.equal(result.statusCode, 200)
  t.equal(redirectedHeaders.authorization, 'Bearer client-token')
  t.equal(redirectedHeaders['nxt-user-id'], 'trusted-user')
})

test('cross-origin redirect leaves an unconfigured custom header intact', async (t) => {
  const result = await runRedirect(
    [
      { statusCode: 302, headers: { location: 'http://destination.test/final' } },
      { statusCode: 200, headers: {} },
    ],
    {
      origin: 'http://source.test',
      path: '/first',
      method: 'GET',
      headers: {
        authorization: 'Bearer client-token',
        cookie: 'session=client-cookie',
        'nxt-user-id': 'trusted-user',
        'proxy-authorization': 'Basic proxy-token',
      },
      proxy: {},
      follow: 1,
    },
  )

  const redirectedHeaders = lowerCaseHeaders(result.attempts[1].headers)
  t.equal(result.statusCode, 200)
  t.notOk(redirectedHeaders.authorization)
  t.notOk(redirectedHeaders['proxy-authorization'])
  t.notOk(redirectedHeaders.cookie)
  t.equal(redirectedHeaders['nxt-user-id'], 'trusted-user')
})
