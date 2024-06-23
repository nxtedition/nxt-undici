export default (opts) => (dispatch) => (opts, handler) => {
  if (typeof opts.body !== 'function') {
    return dispatch(opts, handler)
  }

  try {
    const body = opts.body({ signal: opts.signal })

    if (typeof body?.then === 'function') {
      body.then(
        (body) => {
          dispatch({ ...opts, body }, handler)
        },
        (err) => {
          handler.onConnect(() => {})
          handler.onError(err)
        },
      )
    } else {
      dispatch({ ...opts, body }, handler)
    }
  } catch (err) {
    handler.onConnect(() => {})
    handler.onError(err)
  }
}
