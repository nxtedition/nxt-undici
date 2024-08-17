export default (opts) => (dispatch) => (opts, handler) => {
  if (typeof opts.body !== 'function') {
    return dispatch(opts, handler)
  }

  try {
    const body = opts.body({ signal: opts.signal })

    if (typeof body?.then === 'function') {
      body
        .then((body) => {
          dispatch({ ...opts, body }, handler)
        })
        .catch((err) => {
          handler.onError(err)
        })
      return true
    } else {
      return dispatch({ ...opts, body }, handler)
    }
  } catch (err) {
    handler.onError(err)
    return true
  }
}
