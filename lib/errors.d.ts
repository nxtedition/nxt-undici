export class UndiciError extends Error {
  code: string
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
