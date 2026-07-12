import type { DispatchOptions, FollowFn, ProxyOptions, ProxyRequestTarget } from '../lib/index.js'

const parsedTarget = {
  origin: 'http://client-selected.example',
  pathname: '/canonical/path',
  search: '?value=1',
} as const satisfies ProxyRequestTarget

const originBoundHeaders = ['nxt-user-id', 'x-tenant-id'] as const
const proxy = {
  requestTarget: parsedTarget,
  originBoundHeaders,
} satisfies ProxyOptions

const follow: FollowFn = function (location, count, opts) {
  void [location, count, this]
  opts.follow = { count: 1 }
  return true
}

const options: DispatchOptions = {
  origin: 'http://configured-upstream.example',
  path: 'http://client-selected.example/canonical/path?value=1',
  proxy,
  follow,
}

const counted: DispatchOptions = { follow: { count: 2 } }
const urlTarget: ProxyRequestTarget = new URL('http://client-selected.example/path')

// @ts-expect-error A parsed request target must include a pathname.
const missingPathname: ProxyRequestTarget = { search: '?value=1' }

// @ts-expect-error Origin-bound header names must be strings.
const invalidHeaders: ProxyOptions = { originBoundHeaders: ['valid', 1] }

// @ts-expect-error A counted follow policy requires a numeric count.
const invalidFollow: DispatchOptions = { follow: { count: '2' } }

void [options, counted, urlTarget, missingPathname, invalidHeaders, invalidFollow]
