import { Readable, finished } from 'node:stream'
import { DecoratorHandler, isStream } from '../utils.js'

function noop() {}

class FactoryStream extends Readable {
  #factory
  #ac
  #body
  #removeBodyListeners = noop
  #cleanupFinished = noop

  constructor(factory) {
    super()
    this.#factory = factory
  }

  _construct(callback) {
    this.#ac = new AbortController()
    // destroy() can run before Node schedules _construct(). In that case the
    // factory still runs, but it must receive an already-aborted signal so a
    // pending factory can cancel instead of keeping its resources alive.
    if (this.destroyed) {
      this.#abortFactory(this.errored)
    }
    // Note: #ac is intentionally kept after the factory settles, so that a
    // destroy with an error can still abort the factory's signal (see
    // _destroy) — e.g. the request failing before undici started writing
    // the body.
    Promise.resolve(this.#factory({ signal: this.#ac.signal })).then(
      (body) => {
        try {
          // Normalize binary bodies to Buffer (zero-copy: reinterpret the same
          // memory). Without this a TypedArray/DataView falls through to
          // Readable.from(), which iterates e.g. a Uint8Array element-wise and
          // push(number) then throws an uncaught ERR_INVALID_ARG_TYPE inside
          // the 'data' emit. Mirrors utils.js isBuffer() treating Uint8Array
          // as a buffer, extended to all ArrayBuffer views.
          if (ArrayBuffer.isView(body) && !Buffer.isBuffer(body)) {
            body = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
          } else if (body instanceof ArrayBuffer) {
            body = Buffer.from(body)
          }

          if (typeof body === 'string' || Buffer.isBuffer(body)) {
            this.push(body)
            this.push(null)
          } else if (isStream(body)) {
            // A factory may resolve after its stream has already emitted
            // 'end'. Attaching an end listener at that point can never
            // complete this wrapper. Treat a cleanly exhausted result as an
            // empty body; a stream closed before end still goes through
            // finished() below and reports ERR_STREAM_PREMATURE_CLOSE.
            if (body.readableEnded) {
              this.push(null)
            } else {
              this.#body = body
            }
          } else {
            this.#body = Readable.from(body)
          }

          if (this.#body != null) {
            const bodyStream = this.#body
            const onData = (data) => {
              // `?.`: a 'data' event can still be queued when _destroy() has
              // already nulled #body, and `_read` guards the same way.
              if (!this.push(data)) {
                this.#body?.pause()
              }
            }
            const onEnd = () => this.push(null)

            // Register our end handler before finished(): it must push the
            // outer EOF before finished's terminal callback removes listeners.
            bodyStream.on('end', onEnd)

            // `finished` (not a bare 'error' listener) so a premature close —
            // the inner body destroyed without emitting 'end' or 'error', which
            // surfaces only as 'close' — becomes ERR_STREAM_PREMATURE_CLOSE and
            // fails the request, instead of hanging forever with no terminal
            // push(null). writable:false: these inner bodies are read-only.
            this.#cleanupFinished = finished(bodyStream, { writable: false }, (err) => {
              if (err) {
                this.destroy(err)
              }
            })

            bodyStream.on('data', onData)
            this.#removeBodyListeners = () => {
              bodyStream.removeListener('data', onData)
              bodyStream.removeListener('end', onEnd)
            }
          }

          callback(null)
        } catch (err) {
          callback(err)
        }
      },
      (err) => callback(err),
    )
  }

  _read() {
    this.#body?.resume()
  }

  destroy(err) {
    // Node defers _destroy() until an asynchronous _construct() calls back.
    // A factory waiting for its signal would therefore deadlock teardown:
    // _destroy waits for the factory while the factory waits for _destroy to
    // abort it. Abort synchronously when destroy() is requested instead.
    this.#abortFactory(err)
    return super.destroy(err)
  }

  #abortFactory(err) {
    if (this.#ac && !this.#ac.signal.aborted && (err || !this.readableEnded)) {
      this.#ac.abort(err)
    }
  }

  _destroy(err, callback) {
    if (this.#ac) {
      // Abort the factory's signal on any error, and on a premature destroy
      // (destroyed before 'end'), so the factory can cancel whatever it is
      // producing. A clean destroy after a fully consumed body (autoDestroy
      // after 'end') must not abort — the factory finished normally.
      this.#abortFactory(err)
      this.#ac = null
    }

    this.#removeBodyListeners()
    this.#removeBodyListeners = noop

    if (this.#body) {
      const bodyStream = this.#body
      const cleanupFinished = this.#cleanupFinished
      // Keep finished's error listener installed until destroy() has emitted
      // the inner stream's terminal events. Removing it first would turn a
      // propagated body error into an uncaught second 'error' emission.
      if (bodyStream.closed) {
        cleanupFinished()
      } else {
        bodyStream.once('close', cleanupFinished)
        bodyStream.destroy(err)
      }
      this.#body = null
    } else {
      this.#cleanupFinished()
    }
    this.#cleanupFinished = noop

    callback(err)
  }
}

class Handler extends DecoratorHandler {
  #body

  constructor(handler, body) {
    super(handler)
    this.#body = body
  }

  onError(err) {
    // Undici only destroys a request body once it has started writing it. If
    // the dispatch fails before that (connect error/timeout, DNS failure,
    // abort while queued, sync throw from an inner interceptor), nobody else
    // owns the FactoryStream — but the factory has already run on nextTick
    // (side effects, e.g. an open fd from fs.createReadStream), so destroy it
    // here. destroy() is idempotent: if undici already consumed or destroyed
    // the stream this is a no-op.
    this.#body.destroy(err)
    super.onError(err)
  }
}

export default () => (dispatch) => (opts, handler) => {
  if (typeof opts.body !== 'function') {
    return dispatch(opts, handler)
  }

  const body = new FactoryStream(opts.body).on('error', noop)
  try {
    const result = dispatch({ ...opts, body }, new Handler(handler, body))
    if (result != null && typeof result.catch === 'function') {
      // DispatchFn permits Promise<void>. A rejecting async dispatcher may not
      // also report the failure through handler.onError, so attach cleanup to
      // the original promise while returning it unchanged to the caller.
      result.catch((err) => body.destroy(err))
    }
    return result
  } catch (err) {
    body.destroy(err)
    throw err
  }
}
