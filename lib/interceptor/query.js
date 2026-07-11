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

  let normalized = queryParams
  if (queryParams != null && typeof queryParams === 'object') {
    normalized = Object.create(null)
    for (const key of Object.keys(queryParams)) {
      const normalizedKey = key.toWellFormed()
      const value = queryParams[key]
      const normalizedValue = Array.isArray(value)
        ? value.map((item) => (typeof item === 'string' ? item.toWellFormed() : item))
        : typeof value === 'string'
          ? value.toWellFormed()
          : value

      // Distinct malformed keys can normalize to the same replacement string.
      // Preserve both fields as repeated values instead of silently overwriting
      // one while constructing the normalized object.
      if (Object.hasOwn(normalized, normalizedKey)) {
        const previous = normalized[normalizedKey]
        normalized[normalizedKey] = [
          ...(Array.isArray(previous) ? previous : [previous]),
          ...(Array.isArray(normalizedValue) ? normalizedValue : [normalizedValue]),
        ]
      } else {
        normalized[normalizedKey] = normalizedValue
      }
    }
  }

  let stringified = stringify(normalized)

  // fast-querystring emits separators for keys whose value is an empty array,
  // even though it emits no field for the key itself. Encoded names/values
  // cannot contain a raw `&`, so empty segments are exactly those no-op keys.
  if (stringified.startsWith('&') || stringified.endsWith('&') || stringified.includes('&&')) {
    stringified = stringified.split('&').filter(Boolean).join('&')
  }

  if (stringified) {
    url += '?' + stringified
  }

  return url
}
