import { errors } from '@nxtedition/undici'
import { test } from 'tap'
import {
  AbortError,
  InvalidArgumentError,
  RequestAbortedError,
  UndiciError,
} from '../lib/errors.js'
import { RequestHandler } from '../lib/request.js'
import { validateTrace } from '../lib/trace.js'

test('deep-import error facade preserves dependency constructor identity', (t) => {
  t.equal(UndiciError, errors.UndiciError)
  t.equal(InvalidArgumentError, errors.InvalidArgumentError)
  t.equal(AbortError, errors.AbortError)
  t.equal(RequestAbortedError, errors.RequestAbortedError)
  t.end()
})

test('request validation uses the dependency InvalidArgumentError', (t) => {
  const err = t.throws(
    () => new RequestHandler({ method: 'GET', body: null }, 'not-a-function'),
    /invalid resolve/,
  )

  t.ok(err instanceof errors.InvalidArgumentError)
  t.equal(err.constructor, errors.InvalidArgumentError)
  t.end()
})

test('trace validation uses the dependency InvalidArgumentError', (t) => {
  const err = t.throws(() => validateTrace({}), /invalid trace/)

  t.ok(err instanceof errors.InvalidArgumentError)
  t.equal(err.constructor, errors.InvalidArgumentError)
  t.end()
})

test('request abort fallback uses the dependency RequestAbortedError', (t) => {
  const signal = {
    aborted: true,
    reason: undefined,
    addEventListener() {},
    removeEventListener() {},
  }
  const handler = new RequestHandler({ method: 'GET', body: null, signal }, () => {})
  let reason

  handler.onConnect((err) => {
    reason = err
  })

  t.ok(reason instanceof errors.RequestAbortedError)
  t.equal(reason.constructor, errors.RequestAbortedError)
  t.end()
})
