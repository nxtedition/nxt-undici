import { test } from 'tap'
import xxhash from 'xxhash-wasm'
import { interceptors } from '../lib/index.js'

const ORIGIN = 'https://victim.test:8443'
const RECORDS = [
  { address: '192.0.2.10', family: 4 },
  { address: '192.0.2.11', family: 4 },
  { address: '192.0.2.12', family: 4 },
]
const HASHER = await xxhash()

const cases = [
  {
    name: 'network-path reference',
    path: '//attacker.test:9443/network?query=1',
    pathname: '//attacker.test:9443/network',
  },
  {
    name: 'absolute-form URL',
    path: 'http://attacker.test:9443/absolute?query=1',
    pathname: '/http://attacker.test:9443/absolute',
  },
  {
    name: 'slash-backslash authority',
    path: '/\\attacker.test:9443/backslash?query=1',
    pathname: '//attacker.test:9443/backslash',
  },
  {
    name: 'leading backslash authority',
    path: '\\\\attacker.test:9443/backslash-root?query=1',
    pathname: '///attacker.test:9443/backslash-root',
  },
  {
    name: 'ordinary origin-form path',
    path: '/safe//attacker.test:9443/path?query=1',
    pathname: '/safe//attacker.test:9443/path',
  },
]

for (const { name, path, pathname } of cases) {
  test(`dns: ${name} cannot replace the configured origin authority`, async (t) => {
    const lookups = []
    let seen

    const lookup = (hostname, options, callback) => {
      lookups.push({ hostname, options })
      callback(null, RECORDS)
    }
    const dispatch = interceptors.dns()((opts, handler) => {
      seen = opts
      handler.onConnect(() => {})
      handler.onComplete([])
    })

    await new Promise((resolve, reject) => {
      dispatch(
        {
          origin: ORIGIN,
          path,
          method: 'GET',
          headers: {},
          dns: { balance: 'hash', lookup, ttl: 30_000 },
        },
        {
          onConnect() {},
          onHeaders() {
            return true
          },
          onData() {},
          onComplete: resolve,
          onError: reject,
        },
      )
    })

    t.same(lookups, [{ hostname: 'victim.test', options: { all: true } }])
    t.equal(seen.path, path, 'the original request path is forwarded unchanged')
    t.equal(seen.headers.host, 'victim.test:8443', 'Host remains the configured authority')

    const selected = RECORDS[HASHER.h32(pathname) % RECORDS.length].address
    const rewritten = new URL(seen.origin)
    t.equal(rewritten.protocol, 'https:', 'the configured scheme is preserved')
    t.equal(rewritten.hostname, selected, 'hash balancing uses the path under the fixed origin')
    t.equal(rewritten.port, '8443', 'the configured port is preserved')
  })
}
