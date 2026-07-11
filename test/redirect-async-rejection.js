import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'tap'
import redirect from '../lib/interceptor/redirect.js'

const opts = {
  origin: 'http://example.test',
  path: '/',
  method: 'GET',
  headers: {},
  follow: 1,
}

function withRedirect(followup, handler) {
  let attempts = 0
  const initialResult = {}
  const dispatch = redirect()((dispatchOpts, redirectHandler) => {
    attempts++
    redirectHandler.onConnect(() => {})

    if (attempts === 1) {
      redirectHandler.onHeaders(302, { location: '/next' }, () => {})
      redirectHandler.onComplete({})
      return initialResult
    }

    return followup(redirectHandler)
  })

  const result = dispatch(opts, handler)
  return { attempts: () => attempts, initialResult, result }
}

test('redirect follow-up observes a generic rejected thenable', async (t) => {
  const reason = new Error('redirect follow-up rejected')
  const errors = []
  let thenCalls = 0
  const thenable = {
    then(resolve, reject) {
      thenCalls++
      reject(reason)
    },
  }

  const state = withRedirect(() => thenable, {
    onError(err) {
      errors.push(err)
    },
  })

  t.equal(state.result, state.initialResult, 'preserves the initial dispatch return value')
  await tick()
  await tick()

  t.equal(state.attempts(), 2)
  t.equal(thenCalls, 1, 'assimilates the follow-up thenable once')
  t.same(errors, [reason], 'delivers its rejection exactly once')
})

test('redirect follow-up observes a throwing then getter', async (t) => {
  const reason = new Error('then getter failed')
  const errors = []
  let thenReads = 0
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      thenReads++
      throw reason
    },
  })

  withRedirect(() => thenable, {
    onError(err) {
      errors.push(err)
    },
  })

  await tick()
  await tick()

  t.equal(thenReads, 1)
  t.same(errors, [reason], 'turns the accessor failure into one terminal error')
})

test('redirect follow-up rejection does not duplicate an error already reported by dispatch', async (t) => {
  const reason = new Error('duplicate redirect failure')
  const errors = []
  const unhandled = []
  const onUnhandledRejection = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandledRejection)
  t.teardown(() => process.removeListener('unhandledRejection', onUnhandledRejection))

  withRedirect(
    (redirectHandler) => {
      redirectHandler.onError(reason)
      return Promise.reject(reason)
    },
    {
      onError(err) {
        errors.push(err)
      },
    },
  )

  await tick()
  await tick()

  t.same(errors, [reason], 'downstream receives one terminal error')
  t.same(unhandled, [], 'the redundant rejected Promise is still observed')
})

test('redirect follow-up observer contains a downstream onError throw', async (t) => {
  const reason = new Error('redirect follow-up rejected')
  const callbackError = new Error('downstream onError failed')
  const errors = []
  const unhandled = []
  const onUnhandledRejection = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandledRejection)
  t.teardown(() => process.removeListener('unhandledRejection', onUnhandledRejection))

  withRedirect(() => Promise.reject(reason), {
    onError(err) {
      errors.push(err)
      throw callbackError
    },
  })

  await tick()
  await tick()

  t.same(errors, [reason], 'the dispatch rejection reaches downstream once')
  t.same(unhandled, [], 'the detached observer does not create a second rejection')
})
