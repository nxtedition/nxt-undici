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
      expires: Date.now() * 2 + Math.floor(Math.random() * 100),
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
      expires: Date.now() * 2 + Math.floor(Math.random() * 100),
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
      expires: Date.now() * 2 + Math.floor(Math.random() * 100),
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

  if (populate) {
    exampleEntries().forEach((i) => cache.set('GET:/', i))
  }

  return cache
}

test('If no matching entry found, store the response in cache. Else return a matching entry.', (t) => {
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

    cache.close()
  })
})

test('Responses with header Vary: * should not be cached', (t) => {
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

    cache.close()
  })
})

test('307-Redirect Vary on Host, save to cache, fetch from cache', (t) => {
  t.plan(3)
  const server = createServer((req, res) => {
    res.writeHead(307, {
      Vary: 'Host',
      'Cache-Control': 'public, immutable',
      'Content-Length': 3,
      'Content-Type': 'text/html',
      Connection: 'keep-alive',
      Location: 'http://www.blankwebsite.com/',
      datenow: Date.now(),
    })
    res.end('asd')
  })

  t.teardown(server.close.bind(server))

  server.listen(0, async () => {
    const response1 = await undici.request(`http://0.0.0.0:${server.address().port}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache: true,
    })
    let str1 = ''
    for await (const chunk of response1.body) {
      str1 += chunk
    }

    t.equal(str1, 'asd')

    const response2 = await undici.request(`http://0.0.0.0:${server.address().port}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache: true,
    })
    let str2 = ''
    for await (const chunk of response2.body) {
      str2 += chunk
    }

    t.equal(response1.headers.datenow, response2.headers.datenow)
    t.equal(str2, 'asd')
  })
})

test('Cache purging based on its maxSize', (t) => {
  t.plan(1)
  const cache = new CacheStore(':memory:', { maxSize: 500 })

  exampleEntries()
    .concat(exampleEntries())
    .concat(exampleEntries())
    .concat(exampleEntries())
    .forEach((i) => cache.set('GET:/', i))

  const rows = cache.get('GET:/')
  const totalSize = rows.reduce((acc, r) => r.size + acc, 0)

  t.equal(totalSize, 400)
})

test('Cache #maxTTL overwriting entries ttl', (t) => {
  t.plan(1)

  const day = 1000 * 60 * 60 * 24
  const cache = new CacheStore(':memory:', { maxTTL: day })
  exampleEntries().forEach((i) => cache.set('GET:/', i))

  const row = cache.get('GET:/')[0]
  const rowExpires = Math.floor(row.expires / 1000)
  const maxExpires = Math.floor((Date.now() + day) / 1000)

  t.equal(rowExpires, maxExpires)
})

// test('200-OK, save to cache, fetch from cache', (t) => {
//   t.plan(4)
//   const server = createServer((req, res) => {
//     res.writeHead(307, {
//       Vary: 'Origin2, User-Agent, Accept',
//       'Cache-Control': 'public, immutable',
//       'Content-Length': 4,
//       'Content-Type': 'text/html',
//       Connection: 'close',
//       Location: 'http://www.google.com/',
//     })
//     res.end('foob')
//   })

//   t.teardown(server.close.bind(server))

//   const cache = dbsetup()

//   const cacheLength1 = cache.get('GET:/').length

//   server.listen(0, async () => {
//     const serverPort = server.address().port
//     // response not found in cache, response should be added to cache.
//     const response = await undici.request(`http://0.0.0.0:${serverPort}`, {
//       dispatcher: new undici.Agent().compose(interceptors.cache()),
//       cache,
//     })
//     let str = ''
//     for await (const chunk of response.body) {
//       str += chunk
//     }
//     const cacheLength2 = cache.get('GET:/').length

//     // should return the default server response
//     t.equal(str, 'foob')

//     t.equal(cacheLength2, cacheLength1 + 1)

//     // response found in cache, return cached response.
//     const response2 = await undici.request(`http://0.0.0.0:${serverPort}`, {
//       dispatcher: new undici.Agent().compose(interceptors.cache()),
//       headers: {
//         Accept: 'application/txt',
//         'User-Agent': 'Chrome',
//         origin2: 'www.google.com/images',
//       },
//       cache,
//     })
//     let str2 = ''
//     for await (const chunk of response2.body) {
//       str2 += chunk
//     }

//     const cacheLength3 = cache.get('GET:/').length

//     // should return the body from the cached entry
//     t.equal(str2, 'asd2')

//     // cache should still have the same number of entries before
//     // and after a cached entry was used as a response.
//     t.equal(cacheLength3, cacheLength2)

//     cache.close()
//   })
// })
