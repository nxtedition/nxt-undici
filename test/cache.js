import { test } from 'tap'
import { createServer } from 'node:http'
import undici from 'undici'
import { interceptors } from '../lib/index.js'

// Placeholder until we implement a better LRU Cache
class CacheStore {
  constructor() {
    this.cache = new Map()
  }

  set(key, value) {
    this.cache.set(key, value)
  }

  get(key) {
    return this.cache.get(key)
  }
}

async function exampleCache() {
  const cache = new CacheStore()

  const rawHeaders = [
    Buffer.from('Content-Type'),
    Buffer.from('application/json'),
    Buffer.from('Content-Length'),
    Buffer.from('10'),
    Buffer.from('Cache-Control'),
    Buffer.from('public'),
  ]

  const entries = [
    {
      data: {
        statusCode: 200,
        statusMessage: '',
        rawHeaders,
        rawTrailers: ['Hello'],
        body: ['asd1'],
      },
      vary: [
        ['Accept', 'application/xml'],
        ['User-Agent', 'Mozilla/5.0'],
      ],
      size: 100,
      ttl: 31556952000,
    },
    {
      data: {
        statusCode: 200,
        statusMessage: '',
        rawHeaders,
        rawTrailers: ['Hello'],
        body: ['asd2'],
      },
      vary: [
        ['Accept', 'application/txt'],
        ['User-Agent', 'Chrome'],
        ['origin2', 'www.google.com/images'],
      ],
      size: 100,
      ttl: 31556952000,
    },
    // {
    //   statusCode: 200, statusMessage: 'last', rawHeaders, rawTrailers: ['Hello'], body: ['asd3'],
    //   vary: null },
    {
      data: {
        statusCode: 200,
        statusMessage: 'first',
        rawHeaders,
        rawTrailers: ['Hello'],
        body: ['asd4'],
      },
      vary: [
        ['Accept', 'application/json'],
        ['User-Agent', 'Mozilla/5.0'],
        ['host2', 'www.google.com'],
        ['origin2', 'www.google.com/images'],
      ],
      size: 100,
      ttl: 31556952000,
    },
  ]
  cache.set('GET:/', entries)
  return cache
}

test('cache request, no matching entry found. Store response in cache', async (t) => {
  t.plan(4)
  const server = createServer((req, res) => {
    res.writeHead(307, {
      Vary: 'Origin2, User-Agent, Accept',
      'Cache-Control': 'public, immutable',
      'Content-Length': 4,
      'Content-Type': 'text/html',
      Connection: 'close',
      Location: 'http://www.google.com/',
    })
    res.end('foob')
  })

  t.teardown(server.close.bind(server))

  const cache = await exampleCache()

  console.log('Cache before first request:')
  console.log({ cache: cache.cache })

  const cacheLength1 = cache.get('GET:/').length

  console.log({ cacheLength1 })

  server.listen(0, async () => {
    const serverPort = server.address().port
    // response not found in cache, response should be added to cache.
    const response = await undici.request(`http://0.0.0.0:${serverPort}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache,
    })
    let str = ''
    for await (const chunk of response.body) {
      str += chunk
    }
    const cacheLength2 = cache.get('GET:/').length
    console.log({ cacheLength2 })
    console.log({ str })
    t.equal(str, 'foob')
    t.equal(cacheLength2, cacheLength1 + 1)

    console.log('Cache before second request:')
    console.log({ cache: cache.cache })

    // response found in cache, return cached response.
    const response2 = await undici.request(`http://0.0.0.0:${serverPort}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache,
      Accept: 'application/txt',
      'User-Agent': 'Chrome',
      origin2: 'www.google.com/images',
    })
    let str2 = ''
    for await (const chunk of response2.body) {
      str2 += chunk
    }

    const cacheLength3 = cache.get('GET:/').length
    console.log({ cacheLength3 })

    t.equal(str2, 'asd2')
    t.equal(cacheLength3, cacheLength2)
  })
})
