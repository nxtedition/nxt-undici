/* eslint-disable */
import { test } from 'tap'
import { Readable } from 'node:stream'
import {
  parseContentRange,
  parseRangeHeader,
  parseURL,
  parseOrigin,
  isStream,
  isBlobLike,
  isBuffer,
  bodyLength,
  isDisturbed,
  parseHeaders,
  DecoratorHandler,
} from '../lib/utils.js'

// --- parseContentRange ---

test('parseContentRange - valid full range', (t) => {
  const result = parseContentRange('bytes 0-499/1000')
  t.strictSame(result, { start: 0, end: 500, size: 1000 })
  t.end()
})

test('parseContentRange - wildcard size', (t) => {
  const result = parseContentRange('bytes 0-499/*')
  t.strictSame(result, { start: 0, end: 500, size: null })
  t.end()
})

test('parseContentRange - no end', (t) => {
  const result = parseContentRange('bytes 0-/1000')
  t.strictSame(result, { start: 0, end: null, size: 1000 })
  t.end()
})

test('parseContentRange - null input', (t) => {
  t.equal(parseContentRange(null), undefined)
  t.equal(parseContentRange(undefined), undefined)
  t.equal(parseContentRange(''), undefined)
  t.end()
})

test('parseContentRange - non-string input', (t) => {
  t.equal(parseContentRange(123), null)
  t.end()
})

test('parseContentRange - invalid format', (t) => {
  t.equal(parseContentRange('invalid'), null)
  t.equal(parseContentRange('bytes abc-def/ghi'), null)
  t.end()
})

// --- parseRangeHeader ---

test('parseRangeHeader - valid range', (t) => {
  const result = parseRangeHeader('bytes=0-499')
  t.strictSame(result, { start: 0, end: 500, size: null })
  t.end()
})

test('parseRangeHeader - open-ended range', (t) => {
  const result = parseRangeHeader('bytes=100-')
  t.strictSame(result, { start: 100, end: null, size: null })
  t.end()
})

test('parseRangeHeader - rejects content-range format', (t) => {
  t.equal(parseRangeHeader('bytes 0-499/1000'), null)
  t.end()
})

test('parseRangeHeader - null/empty input', (t) => {
  t.equal(parseRangeHeader(null), undefined)
  t.equal(parseRangeHeader(undefined), undefined)
  t.equal(parseRangeHeader(''), undefined)
  t.end()
})

test('parseRangeHeader - non-string input', (t) => {
  t.equal(parseRangeHeader(42), null)
  t.end()
})

test('parseRangeHeader - invalid format', (t) => {
  t.equal(parseRangeHeader('invalid'), null)
  t.end()
})

// --- parseURL ---

test('parseURL - string URL', (t) => {
  const url = parseURL('http://example.com/path?q=1')
  t.equal(url.origin, 'http://example.com')
  t.equal(url.pathname, '/path')
  t.equal(url.search, '?q=1')
  t.end()
})

test('parseURL - URL object passthrough', (t) => {
  const input = new URL('https://example.com/test')
  const url = parseURL(input)
  t.equal(url.href, input.href)
  t.end()
})

test('parseURL - object with origin and path', (t) => {
  const url = parseURL({
    protocol: 'https:',
    hostname: 'example.com',
    pathname: '/test',
  })
  t.ok(url instanceof URL)
  t.equal(url.pathname, '/test')
  t.end()
})

test('parseURL - invalid protocol throws', (t) => {
  t.throws(() => parseURL('ftp://example.com'), /Invalid URL protocol/)
  t.end()
})

test('parseURL - invalid port throws', (t) => {
  t.throws(
    () => parseURL({ protocol: 'http:', hostname: 'example.com', port: 'abc' }),
    /Invalid URL: port/,
  )
  t.end()
})

test('parseURL - null/non-object throws', (t) => {
  t.throws(() => parseURL(null), /Invalid URL/)
  t.throws(() => parseURL(42), /Invalid URL/)
  t.end()
})

test('parseURL - object with origin', (t) => {
  const url = parseURL({
    origin: 'https://example.com',
    pathname: '/test',
  })
  t.ok(url instanceof URL)
  t.equal(url.origin, 'https://example.com')
  t.end()
})

// --- isStream ---

test('isStream - true for streams', (t) => {
  const s = new Readable({ read() {} })
  t.ok(isStream(s))
  t.end()
})

test('isStream - false for non-streams', (t) => {
  t.notOk(isStream(null))
  t.notOk(isStream(undefined))
  t.notOk(isStream('string'))
  t.notOk(isStream(42))
  t.notOk(isStream({}))
  t.end()
})

// --- isBlobLike ---

test('isBlobLike - true for Blob', (t) => {
  const blob = new Blob(['hello'])
  t.ok(isBlobLike(blob))
  t.end()
})

test('isBlobLike - false for non-blobs', (t) => {
  t.notOk(isBlobLike(null))
  t.notOk(isBlobLike('string'))
  t.notOk(isBlobLike({}))
  t.end()
})

// --- isBuffer ---

test('isBuffer - Buffer', (t) => {
  t.ok(isBuffer(Buffer.from('hello')))
  t.ok(isBuffer(new Uint8Array(10)))
  t.end()
})

test('isBuffer - non-buffer', (t) => {
  t.notOk(isBuffer('hello'))
  t.notOk(isBuffer(null))
  t.notOk(isBuffer(42))
  t.end()
})

// --- bodyLength ---

test('bodyLength - null returns 0', (t) => {
  t.equal(bodyLength(null), 0)
  t.equal(bodyLength(undefined), 0)
  t.end()
})

test('bodyLength - buffer returns byteLength', (t) => {
  t.equal(bodyLength(Buffer.from('hello')), 5)
  t.equal(bodyLength(new Uint8Array(10)), 10)
  t.end()
})

test('bodyLength - blob returns size', (t) => {
  const blob = new Blob(['hello'])
  t.equal(bodyLength(blob), 5)
  t.end()
})

// --- isDisturbed ---

test('isDisturbed - null/string/buffer/function returns false', (t) => {
  t.notOk(isDisturbed(null))
  t.notOk(isDisturbed('string'))
  t.notOk(isDisturbed(Buffer.from('hello')))
  t.notOk(isDisturbed(() => {}))
  t.end()
})

test('isDisturbed - undisturbed stream returns false', (t) => {
  const s = new Readable({ read() {} })
  t.notOk(isDisturbed(s))
  t.end()
})

// --- parseHeaders ---

test('parseHeaders - array format', (t) => {
  const result = parseHeaders([
    Buffer.from('Content-Type'),
    Buffer.from('application/json'),
    Buffer.from('X-Custom'),
    Buffer.from('value'),
  ])
  t.equal(result['content-type'], 'application/json')
  t.equal(result['x-custom'], 'value')
  t.end()
})

test('parseHeaders - object format', (t) => {
  const result = parseHeaders({
    'Content-Type': 'application/json',
    'X-Custom': 'value',
  })
  t.equal(result['content-type'], 'application/json')
  t.equal(result['x-custom'], 'value')
  t.end()
})

test('parseHeaders - null values are skipped', (t) => {
  const result = parseHeaders({
    'Content-Type': 'application/json',
    'X-Null': null,
  })
  t.equal(result['content-type'], 'application/json')
  t.notOk(result['x-null'])
  t.end()
})

test('parseHeaders - duplicate keys become arrays', (t) => {
  const result = parseHeaders([
    Buffer.from('Set-Cookie'),
    Buffer.from('a=1'),
    Buffer.from('Set-Cookie'),
    Buffer.from('b=2'),
  ])
  t.strictSame(result['set-cookie'], ['a=1', 'b=2'])
  t.end()
})

test('parseHeaders - merges into existing object', (t) => {
  const existing = { 'x-existing': 'yes' }
  const result = parseHeaders({ 'X-New': 'value' }, existing)
  t.equal(result['x-existing'], 'yes')
  t.equal(result['x-new'], 'value')
  t.same(result, existing)
  t.end()
})

test('parseHeaders - throws on invalid input', (t) => {
  t.throws(() => parseHeaders('invalid'), /invalid argument: headers/)
  t.end()
})

test('parseHeaders - null headers returns empty object', (t) => {
  const result = parseHeaders(null)
  t.strictSame(result, {})
  t.end()
})

// --- DecoratorHandler ---

test('DecoratorHandler - throws on non-object handler', (t) => {
  t.throws(() => new DecoratorHandler(null), /handler must be an object/)
  t.throws(() => new DecoratorHandler('string'), /handler must be an object/)
  t.end()
})

test('DecoratorHandler - proxies calls to handler', (t) => {
  const events = []
  const handler = {
    onConnect(abort) {
      events.push('connect')
    },
    onHeaders(statusCode, headers, resume) {
      events.push('headers')
    },
    onData(data) {
      events.push('data')
    },
    onComplete(trailers) {
      events.push('complete')
    },
  }

  const decorator = new DecoratorHandler(handler)
  decorator.onConnect(() => {})
  decorator.onHeaders(200, {}, () => {})
  decorator.onData(Buffer.from('hello'))
  decorator.onComplete({})

  t.strictSame(events, ['connect', 'headers', 'data', 'complete'])
  t.end()
})

test('DecoratorHandler - prevents duplicate completion', (t) => {
  let completeCount = 0
  const handler = {
    onConnect() {},
    onComplete() {
      completeCount++
    },
  }

  const decorator = new DecoratorHandler(handler)
  decorator.onConnect(() => {})
  decorator.onComplete({})
  decorator.onComplete({})

  t.equal(completeCount, 1)
  t.end()
})

test('DecoratorHandler - prevents calls after error', (t) => {
  let errorCount = 0
  let dataCount = 0
  const handler = {
    onConnect() {},
    onError() {
      errorCount++
    },
    onData() {
      dataCount++
    },
  }

  const decorator = new DecoratorHandler(handler)
  decorator.onConnect(() => {})
  decorator.onError(new Error('test'))
  decorator.onData(Buffer.from('hello'))
  decorator.onError(new Error('test2'))

  t.equal(errorCount, 1)
  t.equal(dataCount, 0)
  t.end()
})
