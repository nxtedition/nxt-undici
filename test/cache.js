import { test } from 'tap'
// import { LRUCache } from 'lru-cache'
import { createServer } from 'node:http'
import undici from 'undici'
import { interceptors } from '../lib/index.js'

// test('cache request', (t) => {
//   t.plan(1)
//   const server = createServer((req, res) => {
//     res.end('asd')
//   })

//   t.teardown(server.close.bind(server))
//   server.listen(0, async () => {
//     const { body } = await undici.request(`http://0.0.0.0:${server.address().port}`, {
//       dispatcher: new undici.Agent().compose(interceptors.cache()),
//       cache: true,
//     })
//     let str = ''
//     for await (const chunk of body) {
//       str += chunk
//     }
//     t.equal(str, 'asd')
//   })
// })

// class CacheStore {
//   constructor({ maxSize = 1024 * 1024 }) {
//     this.maxSize = maxSize
//     this.cache = new LRUCache({ maxSize })
//   }

//   set(key, value, opts) {
//     this.cache.set(key, value, opts)
//   }

//   get(key) {
//     return this.cache.get(key)
//   }
// }

// Error: "invalid size value (must be positive integer). When maxSize or maxEntrySize is used, sizeCalculation or size must be set."
//
// function exampleCache(){
//   const options = {
//     max: 500,
//     maxSize: 5000,
//     sizeCalculation: (value, key) => {
//       return 1
//     },
//   }
//   const cache = new CacheStore(options)
//   cache.set('GET:/', {data: 'dataFromCache', vary: {'origin': 'http://0.0.0.0:54758', 'Accept-Encoding': 'Application/json'}}, {})
//   cache.set('GET:/foobar', {data: 'dataFromCache'}, {})
//   cache.set('POST:/foo', {data: 'dataFromCache', vary: {'host': '0.0.0.0:54758'}}, {})
//   cache.set('GET:/', {data: {
//     headers: [
//       'Vary': {'origin': 'http://0.0.0.0:54758', 'Accept-Encoding': 'Application/json'}
//     ],
//   }})

//   return cache
// }

// test('cache request, found a matching entry in cache', (t) => {
//   t.plan(1)
//   const server = createServer((req, res) => {
//     res.writeHead(200, { Vary: 'Host, Origin, user-agent' })
//     res.end('asd')
//   })

//   t.teardown(server.close.bind(server))

//   // const cache = exampleCache()
//   server.listen(0, async () => {
//     const response = await undici.request(`http://0.0.0.0:${server.address().port}`, {
//       dispatcher: new undici.Agent().compose(
//         interceptors.responseError(),
//         interceptors.requestBodyFactory(),
//         interceptors.log(),
//         interceptors.dns(),
//         interceptors.lookup(),
//         interceptors.requestId(),
//         interceptors.responseRetry(),
//         interceptors.responseVerify(),
//         interceptors.redirect(),
//         interceptors.cache(),
//         interceptors.proxy()
//       ),
//       cache: true,
//       Accept: 'application/txt',
//       'User-Agent': 'Chrome',
//       origin2: 'www.google.com/images'
//     })
//     let str = ''
//     for await (const chunk of response.body) {
//       str += chunk
//     }

//     console.log('response: ')
//     console.log(response)
//     t.equal(str, 'asd2')
//   })
// })

test('cache request, no matching entry found. Store response in cache', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.writeHead(307, {
      Vary: 'Host',
      'Cache-Control': 'public, immutable',
      'Content-Length': 1000,
      'Content-Type': 'text/html',
      Connection: 'keep-alive',
      Location: 'http://www.blankwebsite.com/',
    })
    res.end('asd')
  })

  t.teardown(server.close.bind(server))

  server.listen(0, async () => {
    const response = await undici.request(`http://0.0.0.0:${server.address().port}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache: true,
    })
    let str = ''
    for await (const chunk of response.body) {
      str += chunk
    }

    console.log('response: ')
    console.log(response)
    t.equal(str, 'asd')
  })

  // Here we need to make another request to check if we get back the previous response but from the cache instead.
})
