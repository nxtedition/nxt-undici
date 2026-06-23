import { DecoratorHandler } from '../utils.js'

export default () => (dispatch) => async (opts, handler) => {
  const lookup = opts.lookup

  if (!lookup) {
    return dispatch(opts, handler)
  }

  // Wrap so the catch below can't deliver a second onError: if a downstream
  // layer already reported a terminal callback and then let an error escape
  // dispatch synchronously, DecoratorHandler's #errored/#completed guards
  // absorb the duplicate instead of violating the once-only onError contract.
  const wrapped = new DecoratorHandler(handler)

  try {
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

    return dispatch({ ...opts, origin }, wrapped)
  } catch (err) {
    wrapped.onError(err)
  }
}
