export default (dispatch) => (opts, handler) =>
  typeof opts.body === 'function'
    ? Promise.resolve(opts.body({ signal: opts.signal })).then(
        (body) => dispatch({ ...opts, body }, handler),
        (err) => handler.onError(err),
      )
    : dispatch(opts, handler)
