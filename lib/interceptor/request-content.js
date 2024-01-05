import crypto from 'node:crypto'
import { Transform, pipeline, Readable } from 'node:stream'
import { findHeader, isBuffer, isStream } from '../utils.js'

function getBody(body, opts) {
  if (body == null) {
    return getBody(Readable.from([]), opts)
  } else if (typeof body === 'string') {
    return getBody(Readable.from([Buffer.from(body)]), opts)
  } else if (isBuffer(body)) {
    return getBody(Readable.from([body]), opts)
  } else if (typeof body === 'function') {
    return async (...args) => getBody(await body(...args), opts)
  } else if (isStream(body)) {
    const hasher = opts.md5 ? crypto.createHash('md5') : null
    let pos = 0
    body = pipeline(
      body,
      new Transform({
        transform(chunk, encoding, callback) {
          pos += chunk.length
          this.push(chunk)
          hasher?.update(chunk, encoding)
          callback()
        },
        flush(callback) {
          const hash = hasher?.digest('base64') ?? null

          if (opts.length != null && pos !== Number(opts.length)) {
            callback(
              Object.assign(new Error('Request Content-Length mismatch'), {
                expected: Number(opts.length),
                actual: pos,
              }),
            )
          } else if (opts.md5 != null && hash !== opts.md5) {
            callback(
              Object.assign(new Error('Request Content-MD5 mismatch'), {
                expected: opts.md5,
                actual: hash,
              }),
            )
          } else {
            callback(null)
          }
        },
      }),
    )
  } else {
    return body
  }
}

export default (dispatch) => (opts, handler) => {
  if (opts.upgrade) {
    return dispatch(opts, handler)
  }

  const md5 = opts.md5 ? findHeader(opts.headers, 'content-md5') : null
  const length = findHeader(opts.headers, 'content-length')

  return md5 || length
    ? dispatch({ ...opts, body: getBody(opts.body, { md5, length }) }, handler)
    : dispatch(opts, handler)
}
