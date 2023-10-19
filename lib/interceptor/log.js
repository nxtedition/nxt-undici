const { parseHeaders } = require('../utils')
const { performance } = require('perf_hooks')

// https://github.com/fastify/fastify/blob/main/lib/reqIdGenFactory.js
// 2,147,483,647 (2^31 − 1) stands for max SMI value (an internal optimization of V8).
// With this upper bound, if you'll be generating 1k ids/sec, you're going to hit it in ~25 days.
// This is very likely to happen in real-world applications, hence the limit is enforced.
// Growing beyond this value will make the id generation slower and cause a deopt.
// In the worst cases, it will become a float, losing accuracy.
const maxInt = 2147483647
let nextReqId = Math.floor(Math.random() * maxInt)
function genReqId() {
  nextReqId = (nextReqId + 1) & maxInt
  return `req-${nextReqId.toString(36)}`
}

class Handler {
  constructor(opts, { handler }) {
    this.handler = handler
    this.opts = opts.id ? opts : { ...opts, id: genReqId() }
    this.abort = null
    this.aborted = false
    this.logger = opts.logger.child({ ureq: { id: opts.id } })
    this.pos = 0
    this.startTime = 0
  }

  onConnect(abort) {
    this.abort = abort
    this.startTime = performance.now()
    this.logger.debug({ ureq: this.opts }, 'upstream request started')
    this.handler.onConnect((reason) => {
      this.aborted = true
      this.abort(reason)
    })
  }

  onUpgrade(statusCode, rawHeaders, socket) {
    this.logger.debug({ ureq: this.opts }, 'upstream request upgraded')
    socket.on('close', () => {
      this.logger.debug({ ureq: this.opts }, 'upstream request socket closed')
    })
    return this.handler.onUpgrade(statusCode, rawHeaders, socket)
  }

  onBodySent(chunk) {
    return this.handler.onBodySent(chunk)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage) {
    this.logger.debug(
      {
        ures: { statusCode, headers: parseHeaders(rawHeaders) },
        elapsedTime: this.startTime - performance.now(),
      },
      'upstream request response',
    )
    return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage)
  }

  onData(chunk) {
    this.pos += chunk.length
    return this.handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    this.logger.debug(
      { bytesRead: this.pos, elapsedTime: this.startTime - performance.now() },
      'upstream request completed',
    )
    return this.handler.onComplete(rawTrailers)
  }

  onError(err) {
    if (this.aborted) {
      this.logger.debug(
        { bytesRead: this.pos, elapsedTime: this.startTime - performance.now(), err },
        'upstream request aborted',
      )
    } else {
      this.logger.error(
        { bytesRead: this.pos, elapsedTime: this.startTime - performance.now(), err },
        'upstream request failed',
      )
    }
    return this.handler.onError(err)
  }
}

module.exports = (dispatch) => (opts, handler) =>
  opts.logger ? dispatch(opts, new Handler(opts, { handler })) : dispatch(opts, handler)
