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
    Promise.resolve(() => this.#factory({ signal: this.#ac.signal })).then(
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
              .on('readable', () => this._read())
              .on('end', () => this.push(null))
              .on('error', (err) => this.destroy(err))
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
    const chunk = this.#body?.read()
    if (chunk !== null) {
      this.push(chunk)
    }
  }

  _destroy(err, callback) {
    if (this.#ac != null) {
      this.#ac.abort()
      this.#ac = null
    }

    callback(err)
  }
}

export default () => (dispatch) => (opts, handler) =>
  typeof opts.body !== 'function'
    ? dispatch(opts, handler)
    : dispatch({ ...opts, body: new FactoryStream(opts.body) }, handler)
