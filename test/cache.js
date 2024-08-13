import { test } from 'tap'
import { createServer } from 'node:http'
import undici from 'undici'
import { interceptors } from '../lib/index.js'
import { DatabaseSync } from 'node:sqlite'

class CacheStore {
  constructor() {
    this.database = null
    this.init()
  }

  init() {
    this.database = new DatabaseSync('file:memdb1?mode=memory&cache=shared')

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS cacheInterceptor(
        key TEXT,
        data TEXT,
        vary TEXT,
        size INTEGER,
        ttl INTEGER,
        insertTime INTEGER
      ) STRICT
    `)
  }

  set(key, entry) {
    if (!this.database) {
      throw new Error('Database not initialized')
    }

    // Format the entry object
    entry.data = JSON.stringify(entry.data)
    entry.vary = JSON.stringify(entry.vary)

    const insert = this.database.prepare(
      'INSERT INTO cacheInterceptor (key, data, vary, size, ttl, insertTime) VALUES (?, ?, ?, ?, ?, ?)',
    )

    insert.run(key, entry.data, entry.vary, entry.size, entry.ttl, Date.now())

    this.purge()
  }

  get(key) {
    if (!this.database) {
      throw new Error('Database not initialized')
    }
    this.purge()
    const query = this.database.prepare('SELECT * FROM cacheInterceptor WHERE key = ?')
    const rows = query.all(key)
    rows.map((i) => {
      i.data = JSON.parse(i.data)
      i.vary = JSON.parse(i.vary)
      return i
    })

    // Just in case purge hasn't finished
    const nonExpiredRows = rows.filter((i) => i.insertTime + i.ttl > Date.now())

    return nonExpiredRows
  }

  purge() {
    if (!this.database) {
      throw new Error('Database not initialized')
    }
    const query = this.database.prepare('DELETE FROM cacheInterceptor WHERE insertTime + ttl < ?')
    query.run(Date.now())
  }

  deleteAll() {
    const query = this.database.prepare('DELETE FROM cacheInterceptor')
    query.run()
  }
}

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
      ttl: 31556952000,
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
      ttl: 31556952000,
    },
    // {
    //   statusCode: 200, statusMessage: 'last', rawHeaders, rawTrailers: ['Hello'], body: ['asd3'],
    //   vary: null },
    {
      data: {
        statusCode: 200,
        statusMessage: 'first',
        rawHeaders1,
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
    {
      data: {
        statusCode: 200,
        statusMessage: 'to be purged',
        rawHeaders1,
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
      ttl: 1,
    },
  ]
  return entries
}

// This test will not always pass because of different execution times of operations in the in-memory database each time.
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

  const cache = new CacheStore()

  // populate cache
  cache.deleteAll()
  exampleEntries().forEach((i) => cache.set('GET:/', i))

  const cacheLength1 = cache.get('GET:/').length

  server.listen(0, async () => {
    const serverPort = server.address().port
    // response not found in cache, response should be added to cache.
    const response = await undici.request(`http://0.0.0.0:${serverPort}`, {
      dispatcher: new undici.Agent().compose(interceptors.cache()),
      cache: true,
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
      cache: true,
    })
    let str2 = ''
    for await (const chunk of response2.body) {
      str2 += chunk
    }

    const cacheLength3 = cache.get('GET:/').length

    // should return the body from the cached entry
    t.equal(str2, 'asd2')

    // cache should still have the same number of entries before
    // and after a cached entry was used as a response
    t.equal(cacheLength3, cacheLength2)

    cache.database.close()
  })
})
