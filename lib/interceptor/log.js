import { performance } from 'node:perf_hooks'
import { parseHeaders } from '../utils.js'
import { DecoratorHandler } from 'undici'

class Handler extends DecoratorHandler {
  #handler
  #opts
  #abort
  #aborted = false
  #logger
  #pos
  #stats

  constructor(opts, { handler }) {
    super(handler)

    this.#handler = handler
    this.#opts = opts
    this.#logger = opts.logger.child({ ureq: { id: opts.id } })
    this.#stats = {
      created: performance.now(),
      start: -1,
      end: -1,
      headers: -1,
      firstBodyReceived: -1,
      lastBodyReceived: -1,
    }
  }

  onConnect(abort) {
    this.#pos = 0
    this.#abort = abort
    this.#stats.start = performance.now()
    this.#stats.end = -1
    this.#stats.headers = -1
    this.#stats.firstBodyReceived = -1
    this.#stats.lastBodyReceived = -1

    this.#logger.debug({ ureq: this.#opts }, 'upstream request started')

    return this.#handler.onConnect((reason) => {
      this.#aborted = true
      this.#abort(reason)
    })
  }

  onUpgrade(statusCode, rawHeaders, socket, headers) {
    this.#logger.debug('upstream request upgraded')
    socket.on('close', () => {
      this.#logger.debug('upstream request socket closed')
    })

    return this.#handler.onUpgrade(statusCode, rawHeaders, socket, headers)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    this.#stats.headers = performance.now() - this.#stats.start

    this.#logger.debug(
      {
        ures: { statusCode, headers },
        elapsedTime: this.#stats.headers,
      },
      'upstream request response',
    )

    return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
  }

  onData(chunk) {
    if (this.#stats.firstBodyReceived === -1) {
      this.#stats.firstBodyReceived = performance.now() - this.#stats.start
    }

    this.#pos += chunk.length

    return this.#handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    this.#stats.lastBodyReceived = performance.now() - this.#stats.start
    this.#stats.end = this.#stats.lastBodyReceived

    this.#logger.debug(
      { bytesRead: this.#pos, elapsedTime: this.#stats.end, stats: this.#stats },
      'upstream request completed',
    )

    return this.#handler.onComplete(rawTrailers)
  }

  onError(err) {
    if (this.#stats) {
      this.#stats.end = performance.now() - this.#stats.start
    }

    if (this.#aborted) {
      this.#logger.debug(
        {
          ureq: this.#opts,
          bytesRead: this.#pos,
          elapsedTime: this.#stats.end,
          stats: this.#stats,
          err,
        },
        'upstream request aborted',
      )
    } else {
      this.#logger.error(
        {
          ureq: this.#opts,
          bytesRead: this.#pos,
          elapsedTime: this.#stats.end,
          stats: this.#stats,
          err,
        },
        'upstream request failed',
      )
    }

    return this.#handler.onError(err)
  }
}

export default (dispatch) => (opts, handler) =>
  opts.logger ? dispatch(opts, new Handler(opts, { handler })) : dispatch(opts, handler)
