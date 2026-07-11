import {
  AbortError,
  InvalidArgumentError,
  RequestAbortedError,
  UndiciError,
} from '../lib/errors.js'

const cause = new Error('cause')
const undiciError: Error = new UndiciError('message', { cause })
const invalidArgument: UndiciError = new InvalidArgumentError('invalid')
const abort: UndiciError = new AbortError()
const requestAbort: AbortError = new RequestAbortedError('aborted')

const code: string = requestAbort.code
const name: string = invalidArgument.name

void undiciError
void abort
void code
void name

// @ts-expect-error error messages must be strings
new InvalidArgumentError(42)
