/* eslint-disable */
import { test } from 'tap'
import { compose } from '../lib/index.js'

test('compose with dispatcher object', (t) => {
  const calls = []
  const dispatcher = {
    dispatch(opts, handler) {
      calls.push('dispatch')
      handler.onConnect(() => {})
      handler.onHeaders(200, {}, () => {})
      handler.onComplete({})
    },
  }

  const dispatch = compose(dispatcher)
  t.equal(typeof dispatch, 'function')
  dispatch({}, { onConnect() {}, onHeaders() {}, onComplete() {} })
  t.strictSame(calls, ['dispatch'])
  t.end()
})

test('compose with interceptor', (t) => {
  const calls = []
  const dispatcher = {
    dispatch(opts, handler) {
      calls.push('dispatch:' + opts.modified)
      handler.onConnect(() => {})
      handler.onHeaders(200, {}, () => {})
      handler.onComplete({})
    },
  }

  const interceptor = (dispatch) => (opts, handler) => {
    calls.push('interceptor')
    return dispatch({ ...opts, modified: true }, handler)
  }

  const dispatch = compose(dispatcher, interceptor)
  dispatch({}, { onConnect() {}, onHeaders() {}, onComplete() {} })
  t.strictSame(calls, ['interceptor', 'dispatch:true'])
  t.end()
})

test('compose skips null interceptors', (t) => {
  const dispatcher = {
    dispatch(opts, handler) {
      handler.onConnect(() => {})
      handler.onHeaders(200, {}, () => {})
      handler.onComplete({})
    },
  }

  const dispatch = compose(dispatcher, null, undefined)
  t.equal(typeof dispatch, 'function')
  t.end()
})

test('compose throws on non-function interceptor', (t) => {
  const dispatcher = {
    dispatch(opts, handler) {},
  }

  t.throws(() => compose(dispatcher, 'invalid'), /invalid interceptor/)
  t.end()
})

test('compose chains multiple interceptors', (t) => {
  const order = []
  const dispatcher = {
    dispatch(opts, handler) {
      order.push('dispatch')
      handler.onConnect(() => {})
      handler.onHeaders(200, {}, () => {})
      handler.onComplete({})
    },
  }

  const first = (dispatch) => (opts, handler) => {
    order.push('first')
    return dispatch(opts, handler)
  }

  const second = (dispatch) => (opts, handler) => {
    order.push('second')
    return dispatch(opts, handler)
  }

  const dispatch = compose(dispatcher, first, second)
  dispatch({}, { onConnect() {}, onHeaders() {}, onComplete() {} })
  t.strictSame(order, ['second', 'first', 'dispatch'])
  t.end()
})

test('compose throws on interceptor that returns invalid dispatch', (t) => {
  const dispatcher = {
    dispatch(opts, handler) {},
  }

  // Interceptor that returns a function with wrong arity (1 arg instead of 2)
  const badInterceptor = (dispatch) => (opts) => {}

  t.throws(() => compose(dispatcher, badInterceptor), /invalid interceptor/)
  t.end()
})

test('compose throws on interceptor that returns null', (t) => {
  const dispatcher = {
    dispatch(opts, handler) {},
  }

  const nullInterceptor = (dispatch) => null

  t.throws(() => compose(dispatcher, nullInterceptor), /invalid interceptor/)
  t.end()
})

test('compose with raw dispatch function (not object)', (t) => {
  const calls = []
  const rawDispatch = (opts, handler) => {
    calls.push('raw')
    handler.onConnect(() => {})
    handler.onHeaders(200, {}, () => {})
    handler.onComplete({})
  }

  const interceptor = (dispatch) => (opts, handler) => {
    calls.push('interceptor')
    return dispatch(opts, handler)
  }

  const dispatch = compose(rawDispatch, interceptor)
  dispatch({}, { onConnect() {}, onHeaders() {}, onComplete() {} })
  t.strictSame(calls, ['interceptor', 'raw'])
  t.end()
})
