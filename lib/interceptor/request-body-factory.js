export default () => (dispatch) => (opts, handler) => {
  if (typeof opts.body !== 'function') {
    return dispatch(opts, handler)
  }

  const body = opts.body({ signal: opts.signal })

  if (typeof body?.then === 'function') {
    body.then(
      (body) => {
        dispatch({ ...opts, body }, handler)
      },
      (err) => {
        handler.onError(err)
      },
    )
    return true
  } else {
    return dispatch({ ...opts, body }, handler)
  }
}
