import { test } from 'tap'
import { request } from '../index.js'

test('retry destroy pre response', async (t) => {
  const { body, statusCode } = await request(`http://google.com`)
  await body.dump()
  t.equal(statusCode, 200)
  t.end()
})
