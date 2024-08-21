import { DecoratorHandler, parseHeaders } from '../utils.js'

class Handler extends DecoratorHandler {
  #handler
  #opts
  #logger

  #abort = null
  #aborted = false
  #pos = 0
  #now = 0
  #timing = {
    created: -1,
    connect: -1,
    headers: -1,
    data: -1,
    complete: -1,
    error: -1,
  }

  constructor(opts, { handler }) {
    super(handler)

    this.#handler = handler
    this.#opts = opts
    this.#logger = opts.logger.child({ ureq: { id: opts.id } })

    this.#timing.created = performance.now()
    this.#now += this.#timing.created
  }

  onConnect(abort) {
    this.#pos = 0
    this.#abort = abort

    this.#timing.connect = performance.now() - this.#now
    this.#now += this.#timing.connect

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
    this.#timing.headers = performance.now() - this.#now
    this.#now += this.#timing.headers

    this.#logger = this.#logger.child({ ures: { statusCode, headers } })
    this.#logger.debug({ elapsedTime: this.#timing.headers }, 'upstream request response')

    return this.#handler.onHeaders(statusCode, rawHeaders, resume, statusMessage, headers)
  }

  onData(chunk) {
    if (this.#timing.data === -1) {
      this.#timing.data = performance.now() - this.#now
      this.#now += this.#timing.data
    }

    this.#pos += chunk.length

    return this.#handler.onData(chunk)
  }

  onComplete(rawTrailers) {
    this.#timing.complete = performance.now() - this.#now
    this.#now += this.#timing.complete

    this.#logger.debug(
      {
        elapsedTime: this.#timing.complete,
        bytesRead: this.#pos,
        bytesReadPerSecond: (this.#pos * 1e3) / this.#timing.complete,
        timing: this.#timing,
      },
      'upstream request completed',
    )

    return this.#handler.onComplete(rawTrailers)
  }

  onError(err) {
    this.#timing.error = performance.now() - this.#now
    this.#now += this.#timing.error

    if (this.#aborted) {
      this.#logger.debug(
        {
          ureq: this.#opts,
          bytesRead: this.#pos,
          timing: this.#timing,
          elapsedTime: this.#timing.error,
          err,
        },
        'upstream request aborted',
      )
    } else {
      this.#logger.error(
        {
          ureq: this.#opts,
          bytesRead: this.#pos,
          timing: this.#timing,
          elapsedTime: this.#timing.error,
          err,
        },
        'upstream request failed',
      )
    }

    return this.#handler.onError(err)
  }
}

export default (opts) => (dispatch) => (opts, handler) =>
  opts.logger ? dispatch(opts, new Handler(opts, { handler })) : dispatch(opts, handler)
