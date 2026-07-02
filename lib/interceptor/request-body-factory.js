import { Readable, finished } from 'node:stream'
import { DecoratorHandler, isStream } from '../utils.js'

function noop() {}

class FactoryStream extends Readable {
  #factory
  #ac
  #body

  constructor(factory) {
    super()
    this.#factory = factory
  }

  _construct(callback) {
    this.#ac = new AbortController()
    // Note: #ac is intentionally kept after the factory settles, so that a
    // destroy with an error can still abort the factory's signal (see
    // _destroy) — e.g. the request failing before undici started writing
    // the body.
    Promise.resolve(this.#factory({ signal: this.#ac.signal })).then(
      (body) => {
        try {
          if (typeof body === 'string' || body instanceof Buffer) {
            this.push(body)
            this.push(null)
          } else if (isStream(body)) {
            this.#body = body
          } else {
            this.#body = Readable.from(body)
          }

          if (this.#body != null) {
            this.#body
              .on('data', (data) => {
                // `?.`: a 'data' event can still be queued when _destroy() has
                // already nulled #body, and `_read` guards the same way.
                if (!this.push(data)) {
                  this.#body?.pause()
                }
              })
              .on('end', () => {
                this.push(null)
              })
            // `finished` (not a bare 'error' listener) so a premature close —
            // the inner body destroyed without emitting 'end' or 'error', which
            // surfaces only as 'close' — becomes ERR_STREAM_PREMATURE_CLOSE and
            // fails the request, instead of hanging forever with no terminal
            // push(null). writable:false: these inner bodies are read-only.
            finished(this.#body, { writable: false }, (err) => {
              if (err) {
                this.destroy(err)
              }
            })
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

  _destroy(err, callback) {
    if (this.#ac) {
      // Abort the factory's signal on any error, and on a premature destroy
      // (destroyed before 'end'), so the factory can cancel whatever it is
      // producing. A clean destroy after a fully consumed body (autoDestroy
      // after 'end') must not abort — the factory finished normally.
      if (err || !this.readableEnded) {
        this.#ac.abort(err)
      }
      this.#ac = null
    }

    if (this.#body) {
      this.#body.destroy(err)
      this.#body = null
    }

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
    return dispatch({ ...opts, body }, new Handler(handler, body))
  } catch (err) {
    body.destroy(err)
    throw err
  }
}
