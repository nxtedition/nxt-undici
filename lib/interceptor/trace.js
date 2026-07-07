import { DecoratorHandler } from '../utils.js'
import { InvalidArgumentError } from '../errors.js'
import { traceWrite, traceSafe, traceErr, traceUrl } from '../trace.js'

class Handler extends DecoratorHandler {
  #write

  #id
  #method
  #url
  #created = performance.now()

  #statusCode = null
  /** @type {number | null} */
  #bytes = 0
  #done = false

  constructor(write, opts, { handler }) {
    super(handler)

    this.#write = write
    this.#id = opts.id ?? null
    this.#method = opts.method ?? null
    this.#url = traceUrl(opts)

    traceSafe(
      write,
      { phase: 'start', id: this.#id, method: this.#method, url: this.#url },
      'undici:request',
    )
  }

  onUpgrade(statusCode, headers, socket) {
    this.#statusCode = statusCode

    // After an upgrade the socket is handed over and no onComplete/onError
    // will ever arrive — close of the upgraded socket is the end of the
    // request. Bytes are not tracked on an upgraded socket.
    socket.on('close', () => {
      this.#bytes = null
      this.#end(null)
    })

    super.onUpgrade(statusCode, headers, socket)
  }

  onHeaders(statusCode, headers, resume) {
    this.#statusCode = statusCode

    return super.onHeaders(statusCode, headers, resume)
  }

  onData(chunk) {
    this.#bytes += chunk.length

    return super.onData(chunk)
  }

  onComplete(trailers) {
    this.#end(null)

    super.onComplete(trailers)
  }

  onError(err) {
    this.#end(err)

    super.onError(err)
  }

  // Finalization for a request whose inner dispatch threw synchronously:
  // undici never took ownership of the handler, so no terminal callback
  // (onError/onComplete) will ever arrive and the start doc would be left
  // unpaired. Mirrors log.js's onDispatchError: emit the end doc but do NOT
  // forward onError — the dispatch entry below rethrows and the caller
  // delivers the error to the original handler chain, so forwarding here
  // would double-deliver it.
  onDispatchError(err) {
    this.#end(err)
  }

  // Emit the end doc exactly once per request: aborts arrive as onError, a
  // terminal event may race a sync dispatch throw, and the pairing with the
  // start doc must hold on every path.
  #end(err) {
    if (this.#done) {
      return
    }
    this.#done = true

    traceSafe(
      this.#write,
      {
        phase: 'end',
        id: this.#id,
        method: this.#method,
        url: this.#url,
        statusCode: this.#statusCode,
        durationMs: Math.round(performance.now() - this.#created),
        bytes: this.#bytes,
        err: err != null ? traceErr(err) : null,
      },
      'undici:request',
    )
  }
}

export default () => (dispatch) => (opts, handler) => {
  const trace = opts.trace
  if (trace != null) {
    // Functions are accepted alongside objects: the canonical writer
    // (@nxtedition/trace's makeTrace) is a callable with `write` assigned
    // onto itself. `write` itself must be a function or null at validation
    // time (it flips between the two at runtime) — a `{ write: 42 }` writer
    // must fail fast here, not silently never trace.
    if (
      (typeof trace !== 'object' && typeof trace !== 'function') ||
      !('write' in trace) ||
      (trace.write !== null && typeof trace.write !== 'function')
    ) {
      throw new InvalidArgumentError('invalid trace')
    }
  }

  // Capture-once per request: the resolved fn is used for both the start and
  // the end doc so a writer flipping mid-request cannot break the pairing.
  const write = traceWrite(trace)

  if (write === null) {
    // Tracing disabled (explicit null, inert writer, or no global installed):
    // pass through with zero added work beyond the resolution above.
    return dispatch(opts, handler)
  }

  const traceHandler = new Handler(write, opts, { handler })

  try {
    return dispatch(opts, traceHandler)
  } catch (err) {
    // An inner interceptor threw synchronously at dispatch time. The error
    // escapes past the already-emitted start doc, which would otherwise stay
    // unpaired forever. Finalize and rethrow so outer interceptors observe
    // the same error as before.
    traceHandler.onDispatchError(err)
    throw err
  }
}
