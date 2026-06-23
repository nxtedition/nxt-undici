import { stringify } from 'fast-querystring'

export default () => (dispatch) => (opts, handler) => {
  if (!opts.query) {
    return dispatch(opts, handler)
  }

  const { query, path, ...rest } = opts

  return dispatch({ ...rest, path: serializePathWithQuery(path, query) }, handler)
}

function serializePathWithQuery(url, queryParams) {
  if (typeof url !== 'string') {
    // A path-less object URL leaves opts.path undefined; fail with a clear
    // message instead of a cryptic "Cannot read properties of undefined".
    throw new Error('Query params require a string path.')
  }

  if (url.includes('?') || url.includes('#')) {
    throw new Error('Query params cannot be passed when url already contains "?" or "#".')
  }

  const stringified = stringify(queryParams)

  if (stringified) {
    url += '?' + stringified
  }

  return url
}
