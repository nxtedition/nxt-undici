export default () => (dispatch) => (opts, handler) => {
  if (typeof opts.body !== 'function') {
    return dispatch(opts, handler)
  }

  const body = opts.body({ signal: opts.signal ?? undefined })

  if (typeof body?.then !== 'function') {
    return dispatch({ ...opts, body }, handler)
  }

  body.then(
    (body) => {
      dispatch({ ...opts, body }, handler)
    },
    (err) => {
      handler.onError(err)
    },
  )
}
