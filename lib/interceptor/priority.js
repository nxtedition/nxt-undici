import { Scheduler } from '../utils/scheduler.js'
import { DecoratorHandler } from '../utils.js'

class Handler extends DecoratorHandler {
  #next

  constructor(handler, next) {
    super(handler)
    this.#next = next
  }

  onConnect(abort) {
    this.#release()
    super.onConnect(abort)
  }

  onComplete(trailers) {
    this.#release()
    super.onComplete(trailers)
  }

  onError(err) {
    this.#release()
    super.onError(err)
  }

  #release() {
    if (this.#next) {
      this.#next()
      this.#next = null
    }
  }
}

export default () => (dispatch) => {
  const schedulers = new Map()

  return (opts, handler) => {
    if (opts.priority == null || !opts.origin) {
      return dispatch(opts, handler)
    }

    let scheduler = schedulers.get(opts.origin)
    if (!scheduler) {
      scheduler = new Scheduler({ concurrency: 1 })
      schedulers.set(opts.origin, scheduler)
    }

    scheduler.schedule((next) => {
      try {
        dispatch(opts, new Handler(handler, next))
      } catch (err) {
        next()
        handler.onError(err)
      }
    }, opts.priority)
  }
}
