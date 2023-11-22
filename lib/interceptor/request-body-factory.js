export default (dispatch) => (opts, handler) => {
  if (typeof opts.body !== 'function') {
    return dispatch(opts, handler)
  }

  // TODO (fix): Can we do signal in a better way using
  // a handler?

  const body = opts.body({ signal: opts.signal })

  if (typeof body.then === 'function') {
    body.then(
      (body) => dispatch({ ...opts, body }, handler),
      (err) => handler.onError(err),
    )
  } else {
    dispatch({ ...opts, body }, handler)
  }
}
