import { test } from 'tap'
import { createServer } from 'node:http'
import undici from 'undici'
import { interceptors } from '../lib/index.js'
import { CacheStore } from '../lib/interceptor/cache.js'

function exampleEntries() {
  const rawHeaders1 = [
    Buffer.from('Content-Type'),
    Buffer.from('application/json'),
    Buffer.from('Content-Length'),
    Buffer.from('10'),
    Buffer.from('Cache-Control'),
    Buffer.from('public'),
  ]
  const rawHeaders2 = [
    Buffer.from('Accept'),
    Buffer.from('application/txt'),
    Buffer.from('Content-Length'),
    Buffer.from('4'),
    Buffer.from('origin2'),
    Buffer.from('www.google.com/images'),
    Buffer.from('User-Agent'),
    Buffer.from('Chrome'),
    Buffer.from('Cache-Control'),
    Buffer.from('public'),
  ]

  const entries = [
    {
      data: {
        statusCode: 200,
        statusMessage: '',
        rawHeaders: rawHeaders1,
        rawTrailers: ['Hello', 'world'],
        body: ['asd1'],
      },
      vary: [
        ['Accept', 'application/xml'],
        ['User-Agent', 'Mozilla/5.0'],
      ],
      size: 100,
      expires: Date.now() + 31556952000,
    },
    {
      data: {
        statusCode: 200,
        statusMessage: '',
        rawHeaders: rawHeaders2,
        rawTrailers: ['Hello', 'world'],
        body: ['asd2'],
      },
      vary: [
        ['Accept', 'application/txt'],
        ['User-Agent', 'Chrome'],
        ['origin2', 'www.google.com/images'],
      ],
      size: 100,
      expires: Date.now() + 31556952000,
    },
    {
      data: {
        statusCode: 200,
        statusMessage: 'first',
        rawHeaders: rawHeaders1,
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
      expires: Date.now() + 31556952000,
    },
    {
      data: {
        statusCode: 200,
        statusMessage: 'to be purged',
        rawHeaders: rawHeaders1,
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
      expires: Date.now(),
    },
  ]
  return entries
}

function dbsetup(populate = true) {
  const cache = new CacheStore()
  cache.deleteAll()

  if (populate) {
    exampleEntries().forEach((i) => cache.set('GET:/', i))
  }

  return cache
}

// This test will not always pass because of different execution times of operations in the in-memory database each time.
test('If no matching entry found, store the response in cache. Else return a matching entry.', async (t) => {
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

  const cache = dbsetup()

  const cacheLength1 = cache.get('GET:/').length

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

    // should return the default server response
    t.equal(str, 'foob')

    t.equal(cacheLength2, cacheLength1 + 1)

    // response found in cache, return cached response.
    const response2 = await undici.request(`http://0.0.0.0:${serverPort}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      headers: {
        Accept: 'application/txt',
        'User-Agent': 'Chrome',
        origin2: 'www.google.com/images',
      },
      cache,
    })
    let str2 = ''
    for await (const chunk of response2.body) {
      str2 += chunk
    }

    const cacheLength3 = cache.get('GET:/').length

    // should return the body from the cached entry
    t.equal(str2, 'asd2')

    // cache should still have the same number of entries before
    // and after a cached entry was used as a response.
    t.equal(cacheLength3, cacheLength2)

    cache.database.close()
  })
})

test('Responses with header Vary: * should not be cached', async (t) => {
  t.plan(2)
  const server = createServer((req, res) => {
    res.writeHead(307, {
      Vary: '*',
      'Cache-Control': 'public, immutable',
      'Content-Length': 4,
      'Content-Type': 'text/html',
      Connection: 'close',
      Location: 'http://www.google.com/',
    })
    res.end('foob')
  })

  t.teardown(server.close.bind(server))

  const cache = dbsetup(false)

  const cacheLength1 = cache.get('GET:/').length

  server.listen(0, async () => {
    const serverPort = server.address().port
    // Response not found in cache, response should be added to cache.
    // But the server returns Vary: *, and thus shouldn't be cached.
    const response = await undici.request(`http://0.0.0.0:${serverPort}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache,
      headers: {
        Accept: 'application/txt',
        'User-Agent': 'Chrome',
        origin2: 'response should not be cached',
      },
    })
    let str = ''
    for await (const chunk of response.body) {
      str += chunk
    }
    const cacheLength2 = cache.get('GET:/').length

    // should return the default server response
    t.equal(str, 'foob')

    t.equal(cacheLength2, cacheLength1)

    cache.database.close()
  })
})

test('Store 307-status-responses that happen to be dependent on the Range header', async (t) => {
  t.plan(5)
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

  const cache = dbsetup(false)

  const cacheLength1 = cache.get('GET:/').length

  server.listen(0, async () => {
    const serverPort = server.address().port

    const request1 = undici.request(`http://0.0.0.0:${serverPort}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache,
      headers: {
        range: 'bytes=0-999',
      },
      testing: 'testing 1',
    })

    // response not found in cache, response should be added to cache.
    const response1 = await request1
    let str1 = ''
    for await (const chunk of response1.body) {
      str1 += chunk
    }
    const cacheLength2 = cache.get('GET:/').length

    // should return the default server response
    t.equal(str1, 'foob')
    t.equal(cacheLength1, 0)
    t.equal(cacheLength2, 1)

    const request2 = undici.request(`http://0.0.0.0:${serverPort}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache,
      headers: {
        range: 'bytes=0-999',
      },
      testing: 'testing 2',
    })

    // response found in cache, response should be fetched from cache.
    const response2 = await request2

    let str2 = ''
    for await (const chunk of response2.body) {
      str2 += chunk
    }

    const cacheLength3 = cache.get('GET:/').length

    // should return the cached response
    t.equal(str2, 'foob')
    t.equal(cacheLength3, 1)

    cache.database.close()
  })
})
