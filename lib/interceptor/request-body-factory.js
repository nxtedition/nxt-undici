export default () => (dispatch) => (opts, handler) =>
  typeof opts.body !== 'function'
    ? dispatch(opts, handler)
    : Promise.resolve(opts.body(opts))
        .then((body) => dispatch({ ...opts, body }, handler))
        .catch((err) => handler.onError(err))
