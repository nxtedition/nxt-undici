import { performance } from 'node:perf_hooks'
import { parseHeaders } from '../utils.js'

class Handler {
  constructor(opts, { handler }) {
    this.handler = handler
    this.opts = opts
    this.abort = null
    this.aborted = false
    this.logger = opts.logger.child({ ureq: { id: opts.id } })
    this.pos = 0
    this.stats = {
      start: -1,
      end: -1,
      headers: -1,
      firstBodySent: -1,
      lastBodySent: -1,
      firstBodyReceived: -1,
      lastBodyReceived: -1,
    }
  }

  onConnect(abort) {
    this.abort = abort
    this.stats.start = performance.now()
    this.logger.debug({ ureq: this.opts }, 'upstream request started')

    return this.handler.onConnect((reason) => {
      this.aborted = true
      this.abort(reason)
    })
  }

  onUpgrade(statusCode, rawHeaders, socket, headers) {
    this.logger.debug('upstream request upgraded')
    socket.on('close', () => {
      this.logger.debug('upstream request socket closed')
    })

    return this.handler.onUpgrade(statusCode, rawHeaders, socket, headers)
  }

  onBodySent(chunk) {
    if (this.stats.firstBodySent === -1) {
      this.stats.firstBodySent = performance.now() - this.stats.start
    }

    return this.handler.onBodySent(chunk)
  }

  onRequestSent() {
    this.stats.lastBodySent = performance.now() - this.stats.start

    return this.handler.onRequestSent()
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    this.stats.headers = performance.now() - this.stats.start

    this.logger.debug(
      {
        ures: { statusCode, headers },
        elapsedTime: this.stats.headers,
      },
      'upstream request response',
    )

    return this.handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
  }

  onData(chunk) {
    if (this.stats.firstBodyReceived === -1) {
      this.stats.firstBodyReceived = performance.now() - this.stats.start
    }

    this.pos += chunk.length

    return this.handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    this.stats.lastBodyReceived = performance.now() - this.stats.start
    this.stats.end = this.stats.lastBodyReceived

    this.logger.debug(
      { bytesRead: this.pos, elapsedTime: this.stats.end, stats: this.stats },
      'upstream request completed',
    )

    return this.handler.onComplete(rawTrailers)
  }

  onError(err) {
    this.stats.end = performance.now() - this.stats.start

    if (this.aborted) {
      this.logger.debug(
        { bytesRead: this.pos, elapsedTime: this.stats.end, stats: this.stats, err },
        'upstream request aborted',
      )
    } else {
      this.logger.error(
        { bytesRead: this.pos, elapsedTime: this.stats.end, err },
        'upstream request failed',
      )
    }

    return this.handler.onError(err)
  }
}

export default (dispatch) => (opts, handler) =>
  opts.logger ? dispatch(opts, new Handler(opts, { handler })) : dispatch(opts, handler)
