/* eslint-disable */
// import { createServer } from 'node:http'
// import { test } from 'tap'
// import { request } from '../lib/index.js'

// test('abort short request should not close connection', (t) => {
//   t.plan(1)

//   let cont
//   const server = createServer((req, res) => {
//     res.write('asd')
//     cont = () => {
//       res.end('asd', () => {
//         t.pass()
//       })
//     }
//   })

//   t.teardown(server.close.bind(server))
//   server.listen(0, async () => {
//     const ac = new AbortController()
//     const res = await request(`http://0.0.0.0:${server.address().port}`, { signal: ac.signal })
//     res.on('error', () => {})
//     ac.abort()
//     setTimeout(cont, 1e3)
//   })
// })
