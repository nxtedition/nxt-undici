import assert from 'node:assert'
import { Readable, isDisturbed } from 'node:stream'
import {
  RequestAbortedError,
  NotSupportedError,
  InvalidArgumentError,
  AbortError,
} from './errors.js'

const kConsume = Symbol('kConsume')
const kReading = Symbol('kReading')
const kBody = Symbol('kBody')
const kAbort = Symbol('abort')
const kContentType = Symbol('kContentType')
const kReadLength = Symbol('kReadLength')

const kStatusCode = Symbol('kStatusCode')
const kStatusMessage = Symbol('kStatusMessage')
const kHeaders = Symbol('kHeaders')
const kSize = Symbol('kSize')
const kHandler = Symbol('kHandler')

const noop = () => {}

let ABORT_ERROR

export class BodyReadable extends Readable {
  constructor(
    handler,
    { contentType = '', statusCode, statusMessage, headers, size, abort, highWaterMark, resume },
  ) {
    super({
      autoDestroy: true,
      read: resume,
      highWaterMark,
    })

    this._readableState.dataEmitted = false

    this[kHandler] = handler
    this[kStatusCode] = statusCode
    this[kStatusMessage] = statusMessage
    this[kHeaders] = headers
    this[kSize] = Number.isFinite(size) ? size : null
    this[kAbort] = abort
    this[kReadLength] = 0

    this[kConsume] = null
    this[kBody] = null
    this[kContentType] = contentType

    // Is stream being consumed through Readable API?
    // This is an optimization so that we avoid checking
    // for 'data' and 'readable' listeners in the hot path
    // inside push().
    this[kReading] = false
  }

  get statusCode() {
    return this[kStatusCode]
  }

  get statusMessage() {
    return this[kStatusMessage]
  }

  get headers() {
    return this[kHeaders]
  }

  get size() {
    return this[kSize]
  }

  get body() {
    return this
  }

  _destroy(err, callback) {
    if (!err && !this._readableState.endEmitted) {
      err = ABORT_ERROR ??= new RequestAbortedError()
    }

    if (err) {
      this[kAbort]()
    }

    if (this[kHandler].signal) {
      this[kHandler].signal.removeEventListener('abort', this[kHandler].onAbort)
      this[kHandler].signal = null
    }

    if (!this[kReading]) {
      // Workaround for Node "bug". If the stream is destroyed in same
      // tick as it is created, then a user who is waiting for a
      // promise (i.e micro tick) for installing a 'error' listener will
      // never get a chance and will always encounter an unhandled exception.
      // - tick => process.nextTick(fn)
      // - micro tick => queueMicrotask(fn)
      setImmediate(() => callback(err))
    } else {
      callback(err)
    }
  }

  on(ev, ...args) {
    if (ev === 'data' || ev === 'readable') {
      this[kReading] = true
    }
    return super.on(ev, ...args)
  }

  addListener(ev, ...args) {
    return this.on(ev, ...args)
  }

  off(ev, ...args) {
    const ret = super.off(ev, ...args)
    if (ev === 'data' || ev === 'readable') {
      this[kReading] = this.listenerCount('data') > 0 || this.listenerCount('readable') > 0
    }
    return ret
  }

  removeListener(ev, ...args) {
    return this.off(ev, ...args)
  }

  setEncoding(encoding) {
    if (encoding) {
      throw new Error('not supported')
    }
    return super.setEncoding(encoding)
  }

  push(chunk) {
    if (chunk != null) {
      this[kReadLength] += chunk.length
    }

    if (this[kConsume] && chunk !== null) {
      consumePush(this[kConsume], chunk)
      return this[kReading] ? super.push(chunk) : true
    }

    return super.push(chunk)
  }

  // https://fetch.spec.whatwg.org/#dom-body-text
  async text() {
    return consume(this, 'text')
  }

  // https://fetch.spec.whatwg.org/#dom-body-json
  async json() {
    return consume(this, 'json')
  }

  // https://fetch.spec.whatwg.org/#dom-body-blob
  async blob() {
    return consume(this, 'blob')
  }

  // https://fetch.spec.whatwg.org/#dom-body-arraybuffer
  async arrayBuffer() {
    return consume(this, 'arrayBuffer')
  }

  // https://fetch.spec.whatwg.org/#dom-body-formdata
  async formData() {
    // TODO: Implement.
    throw new NotSupportedError()
  }

  // https://fetch.spec.whatwg.org/#dom-body-bodyused
  get bodyUsed() {
    return isDisturbed(this)
  }

  async dump(opts) {
    let limit = Number.isFinite(opts?.limit) ? opts.limit : 128 * 1024
    const signal = opts?.signal

    if (this[kSize] != null && this[kSize] - this[kReadLength] > limit) {
      this.destroy(signal.reason ?? new AbortError())
    }

    if (signal != null && (typeof signal !== 'object' || !('aborted' in signal))) {
      throw new InvalidArgumentError('signal must be an AbortSignal')
    }

    signal?.throwIfAborted()

    if (this._readableState.closeEmitted) {
      return null
    }

    const contentLength = this.headers['content-length']
      ? Number(this.headers['content-length'])
      : null

    if (contentLength != null && contentLength >= limit) {
      this.on('error', () => {}).destroy()
      return
    }

    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        this.destroy(signal.reason ?? new AbortError())
      }
      signal?.addEventListener('abort', onAbort)

      this.on('close', function () {
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) {
          reject(signal.reason ?? new AbortError())
        } else {
          resolve(null)
        }
      })
        .on('error', noop)
        .on('data', function (chunk) {
          limit -= chunk.length
          if (limit <= 0) {
            this.destroy()
          }
        })
        .resume()
    })
  }
}

// https://streams.spec.whatwg.org/#readablestream-locked
function isLocked(self) {
  // Consume is an implicit lock.
  return (self[kBody] && self[kBody].locked === true) || self[kConsume]
}

// https://fetch.spec.whatwg.org/#body-unusable
function isUnusable(self) {
  return isDisturbed(self) || isLocked(self)
}

async function consume(stream, type) {
  assert(!stream[kConsume])

  return new Promise((resolve, reject) => {
    if (isUnusable(stream)) {
      const rState = stream._readableState
      if (rState.destroyed && rState.closeEmitted === false) {
        stream
          .on('error', (err) => {
            reject(err)
          })
          .on('close', () => {
            reject(new TypeError('unusable'))
          })
      } else {
        reject(rState.errored ?? new TypeError('unusable'))
      }
    } else {
      queueMicrotask(() => {
        stream[kConsume] = {
          type,
          stream,
          resolve,
          reject,
          length: 0,
          body: [],
        }

        stream
          .on('error', function (err) {
            consumeFinish(this[kConsume], err)
          })
          .on('close', function () {
            if (this[kConsume].body !== null) {
              consumeFinish(this[kConsume], new RequestAbortedError())
            }
          })

        consumeStart(stream[kConsume])
      })
    }
  })
}

function consumeStart(consume) {
  if (consume.body === null) {
    return
  }

  const { _readableState: state } = consume.stream

  if (state.bufferIndex) {
    const start = state.bufferIndex
    const end = state.buffer.length
    for (let n = start; n < end; n++) {
      consumePush(consume, state.buffer[n])
    }
  } else {
    for (const chunk of state.buffer) {
      consumePush(consume, chunk)
    }
  }

  if (state.endEmitted) {
    consumeEnd(this[kConsume])
  } else {
    consume.stream.on('end', function () {
      consumeEnd(this[kConsume])
    })
  }

  consume.stream.resume()

  while (consume.stream.read() != null) {
    // Loop
  }
}

function consumeEnd(consume) {
  const { type, body, resolve, stream, length } = consume

  try {
    if (type === 'text') {
      resolve(Buffer.concat(body).toString().toWellFormed())
    } else if (type === 'json') {
      resolve(JSON.parse(Buffer.concat(body)))
    } else if (type === 'arrayBuffer') {
      const dst = new Uint8Array(length)

      let pos = 0
      for (const buf of body) {
        dst.set(buf, pos)
        pos += buf.byteLength
      }

      resolve(dst.buffer)
    } else if (type === 'blob') {
      resolve(new Blob(body, { type: stream[kContentType] }))
    }

    consumeFinish(consume)
  } catch (err) {
    stream.destroy(err)
  }
}

function consumePush(consume, chunk) {
  consume.length += chunk.length
  consume.body.push(chunk)
}

function consumeFinish(consume, err) {
  if (consume.body === null) {
    return
  }

  if (err) {
    consume.reject(err)
  } else {
    consume.resolve()
  }

  consume.type = null
  consume.stream = null
  consume.resolve = null
  consume.reject = null
  consume.length = 0
  consume.body = null
}
