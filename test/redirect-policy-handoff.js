import { test } from 'tap'
import { compose, interceptors } from '../lib/index.js'

function cloneHeaders(headers) {
  if (Array.isArray(headers)) {
    return [...headers]
  }

  return headers && typeof headers === 'object' ? { ...headers } : headers
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
    let headers

    try {
      dispatch(opts, {
        onConnect() {},
        onHeaders(nextStatusCode, nextHeaders) {
          statusCode = nextStatusCode
          headers = nextHeaders
          return true
        },
        onData() {},
        onComplete() {
          resolve({ attempts, headers, statusCode })
        },
        onError: reject,
      })
    } catch (err) {
      reject(err)
    }
  })
}

const redirectChain = [
  { statusCode: 302, headers: { location: '/second' } },
  { statusCode: 302, headers: { location: '/final' } },
]

test('redirect policy replacement keeps live this binding and count', async (t) => {
  const calls = []
  const result = await runRedirect(redirectChain, {
    origin: 'http://source.test',
    path: '/first',
    method: 'GET',
    headers: {},
    follow(location, count, opts) {
      calls.push({ count, location, thisMatchesOpts: this === opts })
      opts.follow = function replacement(nextLocation, nextCount, nextOpts) {
        calls.push({
          count: nextCount,
          location: nextLocation,
          thisMatchesOpts: this === nextOpts,
        })
        return false
      }
      return true
    },
  })

  t.equal(result.statusCode, 302)
  t.equal(result.headers.location, '/final')
  t.equal(result.attempts.length, 2)
  t.same(calls, [
    { count: 1, location: '/second', thisMatchesOpts: true },
    { count: 2, location: '/final', thisMatchesOpts: true },
  ])
})

for (const { label, policy } of [
  { label: 'a number', policy: 1 },
  { label: 'a counted policy', policy: { count: 1 } },
]) {
  test(`redirect policy handoff to ${label} preserves history`, async (t) => {
    const promise = runRedirect(redirectChain, {
      origin: 'http://source.test',
      path: '/first',
      method: 'GET',
      headers: {},
      follow(location, count, opts) {
        t.equal(location, '/second')
        t.equal(count, 1)
        t.equal(this, opts)
        opts.follow = policy
        return true
      },
    })

    const err = await promise.then(
      () => null,
      (reason) => reason,
    )
    t.type(err, Error)
    t.equal(err.message, 'Max redirections reached: 1.')
    t.same(err.history, ['/second', '/final'])
  })
}

for (const { label, policy } of [
  { label: 'false', policy: false },
  { label: '0', policy: 0 },
  { label: 'undefined', policy: undefined },
]) {
  test(`redirect policy handoff to ${label} passes through the next redirect`, async (t) => {
    const result = await runRedirect(redirectChain, {
      origin: 'http://source.test',
      path: '/first',
      method: 'GET',
      headers: {},
      follow(location, count, opts) {
        t.equal(location, '/second')
        t.equal(count, 1)
        t.equal(this, opts)
        opts.follow = policy
        return true
      },
    })

    t.equal(result.statusCode, 302)
    t.equal(result.headers.location, '/final')
    t.equal(result.attempts.length, 2)
    t.equal(result.attempts[1].follow, policy)
  })
}
