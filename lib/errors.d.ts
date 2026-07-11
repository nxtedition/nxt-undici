export class UndiciError extends Error {
  name: string
  code: string
  constructor(message?: string, options?: ErrorOptions)
}

export class InvalidArgumentError extends UndiciError {
  constructor(message?: string)
}

export class AbortError extends UndiciError {
  constructor(message?: string)
}

export class RequestAbortedError extends AbortError {
  constructor(message?: string)
}
