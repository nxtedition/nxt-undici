export default () => (dispatch) => (opts, handler) => {
  const lookup = opts.lookup

  if (!lookup) {
    return dispatch(opts, handler)
  }

  const callback = (err, origin) => {
    if (err) {
      handler.onError(err)
    } else {
      dispatch({ ...opts, origin }, handler)
    }
  }

  try {
    const thenable = lookup(opts.origin, { signal: opts.signal ?? undefined }, callback)
    if (typeof thenable?.then === 'function') {
      thenable.then(
        (val) => callback(null, val),
        (err) => callback(err),
      )
    }
  } catch (err) {
    callback(err)
  }
}
