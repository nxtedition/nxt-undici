import { createServer } from 'http'
import { request } from '../'
import send from 'send'
import fs from 'fs'
import assert from 'assert'
import crypto from 'crypto'

const filePath = 'some file path'

let currentResponse
const server = createServer((req, res) => {
  if (Math.random() > 0.8) {
    res.statusCode = 429
    res.end()
    return
  }

  currentResponse = res
  send(req, filePath).pipe(res)
})

async function run() {
  let expected
  {
    const hasher = crypto.createHash('md5')
    for await (const chunk of fs.createReadStream(filePath)) {
      hasher.update(chunk)
    }
    expected = hasher.digest('hex')
  }

  server.listen(0, async () => {
    for (let n = 0; n < 10e3; n++) {
      const body = await request(`http://0.0.0.0:${server.address().port}`)
      const hasher = crypto.createHash('md5')
      await new Promise((resolve) =>
        body
          .on('data', (data) => {
            hasher.update(data)
            if (Math.random() > 0.95) {
              currentResponse.destroy()
            }
          })
          .on('end', () => {
            const actual = hasher.digest('hex')
            console.log('# ', n, actual, expected)
            assert.equal(actual, expected)
            resolve(null)
          }),
      )
    }
  })
}

run()
