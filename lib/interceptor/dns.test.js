import { test } from 'tap'
import { request } from '../index.js'

test('retry destroy pre response', async (t) => {
  const { body, statusCode } = await request(`http://google.com`)
  await body.dump()
  t.equal(statusCode, 200)
  t.end()
})

// test('expire & retry on error', async (t) => {
//   t.plan(3)

//   const server = http
//     .createServer((req, res) => {
//       res.end()
//     })
//     .listen(0)
//   t.teardown(server.close.bind(server))

//   await once(server, 'listening')

//   let counter = 0
//   const { body } = await request(`http://asd.com:${server.address().port}`, {
//     dns: {
//       resolve4(hostname, opts, callback) {
//         t.pass()
//         if (counter++ === 0) {
//           process.nextTick(callback, null, [{ address: '11.9.9.9', ttl: 600 }])
//         } else {
//           process.nextTick(callback, null, [{ address: '127.0.0.1', ttl: 600 }])
//         }
//       },
//     },
//     retry: 2,
//   })
//   await body.dump()

//   t.pass()
// })

// test('expire on error', async (t) => {
//   t.plan(2)

//   const server = http
//     .createServer((req, res) => {
//       res.end()
//     })
//     .listen(0)
//   t.teardown(server.close.bind(server))

//   await once(server, 'listening')

//   try {
//     const { body } = await request(`http://123.com:${server.address().port}`, {
//       dns: {
//         resolve4(hostname, opts, callback) {
//           process.nextTick(callback, null, [{ address: '10.9.9.9', ttl: 600 }])
//         },
//       },
//       retry: false,
//     })
//     await body.dump()
//   } catch (err) {
//     t.equal(err.code, 'UND_ERR_CONNECT_TIMEOUT')
//   }

//   const { body } = await request(`http://123.com:${server.address().port}`, {
//     dns: {
//       resolve4(hostname, opts, callback) {
//         process.nextTick(callback, null, [{ address: '127.0.0.1', ttl: 600 }])
//       },
//     },
//     retry: false,
//   })
//   await body.dump()

//   console.error('### 4')
//   t.pass()
// })
