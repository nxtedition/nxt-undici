import { DecoratorHandler, parseHeaders } from '../utils.js'

class Handler extends DecoratorHandler {
  #handler
  #opts
  #logger

  #abort
  #aborted = false
  #pos = 0
  #created = 0
  #timing = {
    created: -1,
    connect: -1,
    headers: -1,
    data: -1,
    end: -1,
  }

  #statusCode
  #headers

  constructor(opts, { handler }) {
    super(handler)

    this.#handler = handler
    this.#opts = opts
    this.#logger = opts.logger.child({ ureq: opts })

    this.#created = performance.now()
  }

  onConnect(abort) {
    this.#pos = 0
    this.#abort = abort

    this.#timing.connect = performance.now() - this.#created
    this.#timing.headers = -1
    this.#timing.data = -1
    this.#timing.end = -1

    this.#logger.debug('upstream request started')

    return this.#handler.onConnect((reason) => {
      this.#aborted = true
      this.#abort(reason)
    })
  }

  onUpgrade(statusCode, rawHeaders, socket, headers = parseHeaders(rawHeaders)) {
    this.#timing.headers = performance.now() - this.#created

    this.#logger.debug(
      {
        ures: { statusCode, headers },
        elapsedTime: this.#timing.headers,
      },
      'upstream request upgraded',
    )

    socket.on('close', () => {
      this.#logger.debug('upstream request socket closed')
    })

    return this.#handler.onUpgrade(statusCode, null, socket, headers)
  }

  onHeaders(statusCode, rawHeaders, resume, statusMessage, headers = parseHeaders(rawHeaders)) {
    this.#timing.headers = performance.now() - this.#created

    this.#statusCode = statusCode
    this.#headers = headers

    return this.#handler.onHeaders(statusCode, null, resume, statusMessage, headers)
  }

  onData(chunk) {
    if (this.#timing.data === -1) {
      this.#timing.data = performance.now() - this.#created
    }

    this.#pos += chunk.length

    return this.#handler.onData(chunk)
  }

  onComplete() {
    this.#timing.end = performance.now() - this.#created

    this.#logger.debug(
      {
        ures: {
          statusCode: this.#statusCode,
          headers: this.#headers,
          timing: this.#timing,
          bytesRead: this.#pos,
          bytesReadPerSecond: (this.#pos * 1e3) / (this.#timing.end - this.#timing.data),
        },
        elapsedTime: this.#timing.end,
      },
      'upstream request completed',
    )

    return this.#handler.onComplete()
  }

  onError(err) {
    this.#timing.end = performance.now() - this.#created

    const data = {
      ureq: this.#opts,
      ures: {
        statusCode: this.#statusCode,
        headers: this.#headers,
        timing: this.#timing,
        bytesRead: this.#pos,
        bytesReadPerSecond: (this.#pos * 1e3) / (this.#timing.end - this.#timing.data),
      },
      elapsedTime: this.#timing.end,
      err,
    }

    if (this.#aborted) {
      this.#logger.debug(data, 'upstream request aborted')
    } else {
      this.#logger.error(data, 'upstream request failed')
    }

    return this.#handler.onError(err)
  }
}

export default () => (dispatch) => (opts, handler) =>
  opts.logger ? dispatch(opts, new Handler(opts, { handler })) : dispatch(opts, handler)
