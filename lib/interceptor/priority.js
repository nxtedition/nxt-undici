import { Scheduler } from '@nxtedition/scheduler'
import { DecoratorHandler } from '../utils.js'

class Handler extends DecoratorHandler {
  #scheduler
  #onIdle

  constructor(handler, scheduler, onIdle) {
    super(handler)
    this.#scheduler = scheduler
    this.#onIdle = onIdle
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
      this.#onIdle?.()
    }
  }
}

export default () => (dispatch) => {
  const schedulers = new Map()

  return (opts, handler) => {
    if (opts.priority == null || !opts.origin) {
      return dispatch(opts, handler)
    }

    // Key on the logical origin, not opts.origin: an outer dns interceptor
    // rewrites opts.origin to a rotating resolved IP, which would scatter one
    // logical host across many schedulers and silently defeat the per-origin
    // concurrency limit. dns preserves the logical host in the `host` header.
    const key = (typeof opts.headers?.host === 'string' && opts.headers.host) || opts.origin

    let scheduler = schedulers.get(key)
    if (!scheduler) {
      scheduler = new Scheduler({ concurrency: 1 })
      schedulers.set(key, scheduler)
    }

    // Evict a scheduler once it has fully drained, so a client touching many
    // distinct origins doesn't accumulate them forever. The `=== scheduler`
    // guard avoids deleting a freshly-created replacement; release() drains
    // pending synchronously, so running===0 && pending===0 here means idle.
    const onIdle = () => {
      if (schedulers.get(key) === scheduler && scheduler.running === 0 && scheduler.pending === 0) {
        schedulers.delete(key)
      }
    }

    const priorityHandler = new Handler(handler, scheduler, onIdle)
    scheduler.acquire(
      (priorityHandler) => {
        try {
          dispatch(opts, priorityHandler)
        } catch (err) {
          priorityHandler.onError(err)
        }
      },
      opts.priority,
      priorityHandler,
    )
  }
}
