export default () => (dispatch) => async (opts, handler) => {
  const lookup = opts.lookup

  if (!lookup) {
    return dispatch(opts, handler)
  }

  const origin = await lookup(opts.origin, { signal: opts.signal ?? undefined })
  if (!origin) {
    throw new Error('invalid origin: ' + origin)
  }

  return dispatch({ ...opts, origin }, handler)
}
