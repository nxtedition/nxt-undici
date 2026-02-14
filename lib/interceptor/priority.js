import { Scheduler } from '@nxtedition/scheduler'
import { DecoratorHandler } from '../utils.js'

class Handler extends DecoratorHandler {
  #scheduler

  constructor(handler, scheduler) {
    super(handler)
    this.#scheduler = scheduler
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
    if (this.#scheduler) {
      const scheduler = this.#scheduler
      this.#scheduler = null
      scheduler.release()
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

    scheduler.acquire(() => {
      const priorityHandler = new Handler(handler, scheduler)
      try {
        dispatch(opts, priorityHandler)
      } catch (err) {
        priorityHandler.onError(err)
      }
    }, opts.priority)
  }
}
