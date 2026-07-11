import { EventEmitter } from 'node:events'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'tap'
import priority from '../lib/interceptor/priority.js'
import { request } from '../lib/request.js'

const base = {
  origin: 'http://example.test',
  method: 'GET',
  headers: {},
  priority: 'normal',
}

function handler(overrides = {}) {
  return {
    onConnect() {},
    onHeaders() {},
    onData() {},
    onComplete() {},
    onError() {},
    ...overrides,
  }
}

function writer() {
  const docs = []
  return {
    docs,
    write(doc, op) {
      docs.push({ ...doc, op })
    },
  }
}

async function checkQueuedAbort(t, signal, abort) {
  const seen = []
  let releaseFirst
  const dispatch = priority()((opts, wrapped) => {
    seen.push(opts.path)

    if (opts.path === '/hold') {
      releaseFirst = () => wrapped.onConnect(() => {})
      return true
    }

    wrapped.onConnect((reason) => wrapped.onError(reason))
    if (!opts.signal?.aborted) {
      wrapped.onComplete({})
    }
    return true
  })

  dispatch({ ...base, path: '/hold' }, handler())
  const trace = writer()
  const reason = new Error('queued request aborted')
  const queued = request(dispatch, {
    ...base,
    id: 'queued-request',
    path: '/queued',
    signal,
    trace,
  })
  let rejection
  void queued.catch((err) => {
    rejection = err
  })

  t.same(seen, ['/hold'], 'second request is waiting for scheduler admission')
  t.same(
    trace.docs.filter((doc) => doc.op === 'undici:priority').map((doc) => doc.phase),
    ['queued'],
  )

  abort(reason)
  await tick()
  await tick()

  t.equal(rejection, reason, 'queued request rejects before the active slot is released')
  t.same(seen, ['/hold'], 'abort does not dispatch the queued request downstream')
  const beforeRelease = trace.docs.filter((doc) => doc.op === 'undici:priority')
  t.same(
    beforeRelease.map((doc) => doc.phase),
    ['queued', 'end'],
    'queued trace is paired at cancellation time',
  )
  t.equal(beforeRelease[1]?.holdMs, 0, 'a request that never acquired a slot held it for 0ms')

  releaseFirst()
  t.equal(await queued.catch((err) => err), reason)
  t.same(seen, ['/hold'], 'the admitted cancellation tombstone skips inner dispatch')

  let thirdCompleted = false
  dispatch(
    { ...base, path: '/third' },
    handler({
      onComplete() {
        thirdCompleted = true
      },
    }),
  )

  t.same(seen, ['/hold', '/third'], 'a later request can immediately reuse the drained slot')
  t.equal(thirdCompleted, true)
  t.equal(
    trace.docs.filter((doc) => doc.op === 'undici:priority' && doc.id === 'queued-request').length,
    2,
    'tombstone admission does not emit a second end trace',
  )
}

test('priority: native AbortSignal cancels queued work before admission', async (t) => {
  const controller = new AbortController()
  await checkQueuedAbort(t, controller.signal, (reason) => controller.abort(reason))
})

test('priority: EventEmitter signal cancels queued work before admission', async (t) => {
  const signal = new EventEmitter()
  signal.aborted = false
  await checkQueuedAbort(t, signal, (reason) => {
    signal.aborted = true
    signal.reason = reason
    signal.emit('abort')
  })
})

test('priority: reentrant queue tracing cannot install a stale abort listener', (t) => {
  const signal = Object.assign(new EventEmitter(), { aborted: false, reason: undefined })
  let releaseFirst
  let calls = 0
  let completed = false
  const dispatch = priority()((opts, wrapped) => {
    calls++
    if (calls === 1) {
      releaseFirst = () => wrapped.onConnect(() => {})
      return
    }
    wrapped.onConnect(() => {})
    wrapped.onComplete({})
  })

  dispatch({ ...base, path: '/hold' }, handler())
  const trace = {
    write(doc, op) {
      if (op === 'undici:priority' && doc.phase === 'queued') {
        releaseFirst()
      }
    },
  }
  dispatch(
    { ...base, path: '/queued', signal, trace },
    handler({
      onComplete() {
        completed = true
      },
    }),
  )

  t.equal(calls, 2, 'the queued request was admitted reentrantly by its trace writer')
  t.equal(completed, true)
  t.equal(signal.listenerCount('abort'), 0, 'no queued-only listener is installed after admission')
  t.end()
})
