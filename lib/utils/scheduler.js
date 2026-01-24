import { FixedQueue } from './fixed-queue.js'

export class Scheduler {
  /** @type {0} */
  static LOW = 0
  /** @type {1} */
  static NORMAL = 1
  /** @type {2} */
  static HIGH = 2

  #concurrency
  #running = 0
  #counter = 0

  #lowQueue = new FixedQueue()
  #normalQueue = new FixedQueue()
  #highQueue = new FixedQueue()

  /**
   * @param {{ concurrency?: number }} [options]
   */
  constructor({ concurrency = Infinity } = {}) {
    this.#concurrency = concurrency
  }

  /**
   * @param {(Function) => any} fn
   * @param {0|1|2} priority
   * @returns
   */
  schedule(fn, priority = Scheduler.NORMAL) {
    if (typeof fn !== 'function') {
      throw new TypeError('First argument must be a function')
    }

    if (priority == null) {
      priority = Scheduler.NORMAL
    }

    if (!Number.isInteger(priority)) {
      throw new Error('Invalid priority')
    }

    if (this.#running < this.#concurrency) {
      this.#running++
      return fn(this.#next)
    }

    if (priority > Scheduler.NORMAL) {
      this.#highQueue.push(fn)
    } else if (priority < Scheduler.NORMAL) {
      this.#lowQueue.push(fn)
    } else {
      this.#normalQueue.push(fn)
    }
  }

  #next = () => {
    this.#counter++
    this.#running--

    const fn =
      ((this.#counter & 63) === 0 && this.#lowQueue.shift()) ??
      ((this.#counter & 15) === 0 && this.#normalQueue.shift()) ??
      this.#highQueue.shift() ??
      this.#normalQueue.shift() ??
      this.#lowQueue.shift()

    if (fn) {
      this.#running++
      fn(this.#next)
    }
  }
}
