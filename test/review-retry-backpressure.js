import { test } from 'tap'
import responseRetry from '../lib/interceptor/response-retry.js'

const opts = {
  origin: 'http://example.test',
  path: '/',
  method: 'GET',
  headers: {},
}

test('range retry stays paused until the original response is resumed', async (t) => {
  const retryReady = Promise.withResolvers()
  const completed = Promise.withResolvers()
  const reset = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
  const chunks = []
  let attempt = 0
  let resumeResponse
  let resumedTransport = false

  const dispatch = responseRetry()((requestOpts, handler) => {
    attempt++
    handler.onConnect(() => {})

    if (attempt === 1) {
      t.equal(
        handler.onHeaders(200, { 'content-length': '2', etag: '"v1"' }, () => {}),
        true,
      )
      t.equal(handler.onData(Buffer.from('a')), false, 'the first attempt is paused')
      handler.onError(reset)
      return
    }

    const resume = () => {
      resumedTransport = true
      t.equal(handler.onData(Buffer.from('b')), true)
      handler.onComplete({})
    }
    const ret = handler.onHeaders(206, { 'content-range': 'bytes 1-1/2', etag: '"v1"' }, resume)
    retryReady.resolve(ret)
  })

  dispatch(
    { ...opts, retry: () => true },
    {
      onConnect() {},
      onHeaders(statusCode, headers, resume) {
        t.equal(statusCode, 200)
        resumeResponse = resume
        return true
      },
      onData(chunk) {
        chunks.push(chunk.toString())
        return chunks.length !== 1
      },
      onComplete() {
        completed.resolve()
      },
      onError: completed.reject,
    },
  )

  t.equal(await retryReady.promise, false, 'the resumed transport inherits the pause')
  t.equal(resumedTransport, false, 'the retry has not sent data while paused')
  t.strictSame(chunks, ['a'])

  resumeResponse()
  await completed.promise

  t.equal(resumedTransport, true)
  t.strictSame(chunks, ['a', 'b'])
  t.equal(attempt, 2)
})

test('buffered error replay stops at onData(false) and resumes at the next chunk', async (t) => {
  const firstData = Promise.withResolvers()
  const completed = Promise.withResolvers()
  const chunks = []
  let resumeResponse
  let didComplete = false

  const dispatch = responseRetry()((requestOpts, handler) => {
    handler.onConnect(() => {})
    handler.onHeaders(404, { 'content-length': '2' }, () => {})
    handler.onData(Buffer.from('a'))
    handler.onData(Buffer.from('b'))
    handler.onComplete({ trailer: 'value' })
  })

  dispatch(
    { ...opts, retry: () => false },
    {
      onConnect() {},
      onHeaders(statusCode, headers, resume) {
        t.equal(statusCode, 404)
        resumeResponse = resume
        return true
      },
      onData(chunk) {
        chunks.push(chunk.toString())
        if (chunks.length === 1) {
          firstData.resolve()
          return false
        }
        return true
      },
      onComplete(trailers) {
        didComplete = true
        completed.resolve(trailers)
      },
      onError: completed.reject,
    },
  )

  await firstData.promise
  t.strictSame(chunks, ['a'])
  t.equal(didComplete, false, 'completion waits for the consumer')

  resumeResponse()
  t.strictSame(await completed.promise, { trailer: 'value' })
  t.strictSame(chunks, ['a', 'b'])
})

test('buffer-cap transition drains replay before resuming the live transport', async (t) => {
  const firstData = Promise.withResolvers()
  const completed = Promise.withResolvers()
  const buffered = Buffer.alloc(256 * 1024, 0x61)
  const chunks = []
  let resumeResponse
  let transportResumes = 0
  let didComplete = false

  const dispatch = responseRetry()((requestOpts, handler) => {
    handler.onConnect(() => {})

    const resumeTransport = () => {
      transportResumes++
      const ret = handler.onData(Buffer.from('c'))
      if (ret !== false) {
        handler.onComplete({})
      }
    }

    handler.onHeaders(404, {}, resumeTransport)
    handler.onData(buffered)
    const ret = handler.onData(Buffer.from('b'))
    if (ret !== false) {
      resumeTransport()
    }
  })

  dispatch(
    { ...opts, retry: true },
    {
      onConnect() {},
      onHeaders(statusCode, headers, resume) {
        t.equal(statusCode, 404)
        resumeResponse = resume
        return true
      },
      onData(chunk) {
        chunks.push(chunk)
        if (chunks.length === 1) {
          firstData.resolve()
          return false
        }
        return true
      },
      onComplete() {
        didComplete = true
        completed.resolve()
      },
      onError: completed.reject,
    },
  )

  await firstData.promise
  t.strictSame(
    chunks.map((chunk) => chunk.byteLength),
    [buffered.byteLength],
    'remaining buffered and live chunks wait',
  )
  t.equal(transportResumes, 0)
  t.equal(didComplete, false)

  resumeResponse()
  await completed.promise

  t.strictSame(
    chunks.map((chunk) => chunk.byteLength),
    [buffered.byteLength, 1, 1],
  )
  t.equal(chunks[1].toString(), 'b', 'buffered replay drains first')
  t.equal(chunks[2].toString(), 'c', 'live transport resumes after replay')
  t.equal(transportResumes, 1)
})
