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

test('cache request, vary:host, populated cache', (t) => {
  t.plan(1)
  const server = createServer((req, res) => {
    res.writeHead(307, { Vary: 'Host' })
    res.end('asd')
  })

  t.teardown(server.close.bind(server))

  // const cache = exampleCache()
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
})
