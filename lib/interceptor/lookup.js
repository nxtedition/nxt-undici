export default (opts) => (dispatch) => (opts, handler) => {
  const lookup = opts.lookup

  if (!lookup) {
    dispatch(opts, handler)
    return
  }

  try {
    const callback = (err, origin) => {
      if (err) {
        handler.onConnect(() => {})
        handler.onError(err)
      } else {
        dispatch({ ...opts, origin }, handler)
      }
    }

    const thenable = lookup(opts.origin, callback)
    if (typeof thenable?.then === 'function') {
      thenable.then(
        (val) => callback(null, val),
        (err) => callback(err),
      )
    }
  } catch (err) {
    handler.onConnect(() => {})
    handler.onError(err)
  }
}
