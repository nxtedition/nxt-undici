import { Readable } from 'node:stream'
import { isStream } from '../utils.js'

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
                if (!this.push(data)) {
                  this.pause()
                }
              })
              .on('end', () => {
                this.push(null)
              })
              .on('error', (err) => {
                this.destroy(err)
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
    this.resume()
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
    : dispatch({ ...opts, body: new FactoryStream(opts.body) }, handler)
