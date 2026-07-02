import { Readable, finished } from 'node:stream'
import { isStream } from '../utils.js'

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
    Promise.resolve(this.#factory({ signal: this.#ac.signal })).then(
      (body) => {
        this.#ac = null
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
      this.#ac.abort(err)
      this.#ac = null
    }

    if (this.#body) {
      this.#body.destroy(err)
      this.#body = null
    }

    callback(err)
  }
}

export default () => (dispatch) => (opts, handler) =>
  typeof opts.body !== 'function'
    ? dispatch(opts, handler)
    : dispatch({ ...opts, body: new FactoryStream(opts.body).on('error', noop) }, handler)
