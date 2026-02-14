export default () => (dispatch) => async (opts, handler) => {
  const lookup = opts.lookup

  if (!lookup) {
    return dispatch(opts, handler)
  }

  const origin = await new Promise((resolve, reject) => {
    const thenable = lookup(opts.origin, { signal: opts.signal ?? undefined }, (err, val) => {
      if (err) {
        reject(err)
      } else {
        resolve(val)
      }
    })

    if (thenable != null) {
      Promise.resolve(thenable).then(resolve, reject)
    }
  })

  if (!origin) {
    throw new Error('invalid origin: ' + origin)
  }

  return dispatch({ ...opts, origin }, handler)
}
