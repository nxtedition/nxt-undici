import { test } from 'tap'
import { DecoratorHandler } from '../lib/utils.js'

test('DecoratorHandler treats onUpgrade as a terminal callback', (t) => {
  const calls = []
  let wrappedAbort
  let transportAborts = 0
  const handler = {
    onConnect(abort) {
      wrappedAbort = abort
    },
    onUpgrade() {
      calls.push('upgrade')
    },
    onComplete() {
      calls.push('complete')
    },
    onError() {
      calls.push('error')
    },
  }
  const decorator = new DecoratorHandler(handler)

  decorator.onConnect(() => {
    transportAborts++
  })
  decorator.onUpgrade(101, {}, {})
  decorator.onUpgrade(101, {}, {})
  decorator.onComplete({})
  decorator.onError(new Error('late transport error'))
  wrappedAbort(new Error('late caller abort'))

  t.strictSame(calls, ['upgrade'])
  t.equal(transportAborts, 0)
  t.end()
})
