module.exports = (dispatch) => (opts, handler) =>
  typeof opts.body !== 'function'
    ? dispatch(opts, handler)
    : Promise.resolve(opts.body({ signal: opts.signal })).then(
        (body) => dispatch({ ...opts, body }, handler),
        (err) => handler.onError(err),
      )
