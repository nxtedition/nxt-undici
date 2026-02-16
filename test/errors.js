/* eslint-disable */
import { test } from 'tap'
import {
  UndiciError,
  InvalidArgumentError,
  AbortError,
  RequestAbortedError,
} from '../lib/errors.js'

test('UndiciError', (t) => {
  const err = new UndiciError('test message')
  t.ok(err instanceof Error)
  t.ok(err instanceof UndiciError)
  t.equal(err.name, 'UndiciError')
  t.equal(err.code, 'UND_ERR')
  t.equal(err.message, 'test message')
  t.end()
})

test('InvalidArgumentError', (t) => {
  const err = new InvalidArgumentError('bad arg')
  t.ok(err instanceof Error)
  t.ok(err instanceof UndiciError)
  t.ok(err instanceof InvalidArgumentError)
  t.equal(err.name, 'InvalidArgumentError')
  t.equal(err.code, 'UND_ERR_INVALID_ARG')
  t.equal(err.message, 'bad arg')
  t.end()
})

test('InvalidArgumentError default message', (t) => {
  const err = new InvalidArgumentError()
  t.equal(err.message, 'Invalid Argument Error')
  t.end()
})

test('AbortError', (t) => {
  const err = new AbortError('aborted')
  t.ok(err instanceof Error)
  t.ok(err instanceof UndiciError)
  t.ok(err instanceof AbortError)
  t.equal(err.name, 'AbortError')
  t.equal(err.message, 'aborted')
  t.end()
})

test('AbortError default message', (t) => {
  const err = new AbortError()
  t.equal(err.message, 'The operation was aborted')
  t.end()
})

test('RequestAbortedError', (t) => {
  const err = new RequestAbortedError('req aborted')
  t.ok(err instanceof Error)
  t.ok(err instanceof UndiciError)
  t.ok(err instanceof AbortError)
  t.ok(err instanceof RequestAbortedError)
  t.equal(err.name, 'AbortError')
  t.equal(err.code, 'UND_ERR_ABORTED')
  t.equal(err.message, 'req aborted')
  t.end()
})

test('RequestAbortedError default message', (t) => {
  const err = new RequestAbortedError()
  t.equal(err.message, 'Request aborted')
  t.end()
})
