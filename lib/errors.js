'use strict'

export class UndiciError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'UndiciError'
    this.code = 'UND_ERR'
  }
}

export class InvalidArgumentError extends UndiciError {
  constructor(message) {
    super(message)
    this.name = 'InvalidArgumentError'
    this.message = message || 'Invalid Argument Error'
    this.code = 'UND_ERR_INVALID_ARG'
  }
}

export class AbortError extends UndiciError {
  constructor(message) {
    super(message)
    this.name = 'AbortError'
    this.message = message || 'The operation was aborted'
  }
}

export class RequestAbortedError extends AbortError {
  constructor(message) {
    super(message)
    this.name = 'AbortError'
    this.message = message || 'Request aborted'
    this.code = 'UND_ERR_ABORTED'
  }
}
