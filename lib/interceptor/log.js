import { DecoratorHandler } from '../utils.js'

class Handler extends DecoratorHandler {
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

  constructor(logOpts, opts, { handler }) {
    super(handler)

    this.#opts = opts
    this.#logger = opts.logger.child({ ureq: opts })

    if (logOpts?.bindings) {
      this.#logger = this.#logger.child(logOpts?.bindings)
    }

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

    super.onConnect((reason) => {
      this.#aborted = true
      this.#abort(reason)
    })
  }

  onUpgrade(statusCode, headers, socket) {
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

    super.onUpgrade(statusCode, headers, socket)
  }

  onHeaders(statusCode, headers, resume) {
    this.#timing.headers = performance.now() - this.#created

    this.#statusCode = statusCode
    this.#headers = headers

    return super.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    if (this.#timing.data === -1) {
      this.#timing.data = performance.now() - this.#created
    }

    this.#pos += chunk.length

    return super.onData(chunk)
  }

  onComplete() {
    this.#timing.end = performance.now() - this.#created

    const data = {
      ures: {
        statusCode: this.#statusCode,
        headers: this.#headers,
        timing: this.#timing,
        bytesRead: this.#pos,
        bytesReadPerSecond: (this.#pos * 1e3) / (this.#timing.end - this.#timing.data),
      },
      elapsedTime: this.#timing.end,
    }

    if (this.#statusCode >= 500) {
      this.#logger.error(data, 'upstream request completed')
    } else if (this.#statusCode >= 400) {
      this.#logger.warn(data, 'upstream request completed')
    } else {
      this.#logger.debug(data, 'upstream request completed')
    }

    super.onComplete()
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

    super.onError(err)
  }
}

export default (logOpts) => (dispatch) => (opts, handler) =>
  opts.logger ? dispatch(opts, new Handler(logOpts, opts, { handler })) : dispatch(opts, handler)
