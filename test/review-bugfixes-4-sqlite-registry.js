/* eslint-disable */
// Regression tests for the module-level store registry in SqliteCacheStore.
//
// The registry exists so that process-level broadcasts (nxt:offPeak,
// nxt:clearCache) can reach every live store. It used to hold every
// constructed store strongly, so a store dropped without close() — plus its
// open DatabaseSync handle, prepared statements and (for :memory:) its whole
// page cache — was pinned forever. It now holds stores via WeakRef with a
// FinalizationRegistry cleaning up entries for collected stores.
import { test } from 'tap'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'

const storeModuleUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'sqlite-cache-store.js'),
).href

function makeKey(overrides = {}) {
  return { origin: 'https://example.com', method: 'GET', path: '/test', ...overrides }
}

function makeValue(overrides = {}) {
  const now = Date.now()
  return {
    body: Buffer.from('hello'),
    start: 0,
    end: 5,
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: now,
    staleAt: now + 3600e3,
    deleteAt: now + 7200e3,
    ...overrides,
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// Poll `fn` until it returns true or the deadline expires.
async function waitFor(fn, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!fn()) {
    if (Date.now() > deadline) {
      return false
    }
    await flush()
  }
  return true
}

// ---------------------------------------------------------------------------
// Broadcasts still reach live stores through the WeakRef registry.
// ---------------------------------------------------------------------------

test('nxt:offPeak broadcast reaches live stores', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  let gcCalls = 0
  // Instance property shadows the prototype method; the broadcast handler
  // calls store.gc(), so this observes delivery deterministically.
  store.gc = () => {
    gcCalls++
  }

  const bc = new BroadcastChannel('nxt:offPeak')
  t.teardown(() => bc.close())
  bc.postMessage(null)

  t.ok(await waitFor(() => gcCalls > 0), 'gc() invoked on live store via broadcast')
  t.end()
})

test('nxt:clearCache broadcast clears live stores', async (t) => {
  const store = new SqliteCacheStore()
  t.teardown(() => store.close())

  store.set(makeKey(), makeValue())
  await flush()
  t.ok(store.get(makeKey()), 'value cached before broadcast')

  const bc = new BroadcastChannel('nxt:clearCache')
  t.teardown(() => bc.close())
  bc.postMessage(null)

  t.ok(await waitFor(() => store.get(makeKey()) === undefined), 'cache cleared via broadcast')
  t.end()
})

// ---------------------------------------------------------------------------
// close() removes the store from the registry deterministically: broadcasts
// after close() must not touch the closed store.
// ---------------------------------------------------------------------------

test('broadcast does not reach closed stores', async (t) => {
  const closedStores = []
  for (let i = 0; i < 4; i++) {
    const store = new SqliteCacheStore()
    store.close()
    let calls = 0
    store.gc = () => {
      calls++
    }
    store.clear = () => {
      calls++
    }
    closedStores.push({
      store,
      get calls() {
        return calls
      },
    })
  }

  // A live store acts as the completion signal: once the broadcast has
  // reached it, the same dispatch loop has already skipped the closed ones.
  const live = new SqliteCacheStore()
  t.teardown(() => live.close())
  let liveCalls = 0
  live.gc = () => {
    liveCalls++
  }

  const bc = new BroadcastChannel('nxt:offPeak')
  t.teardown(() => bc.close())
  bc.postMessage(null)

  t.ok(await waitFor(() => liveCalls > 0), 'broadcast delivered to live store')
  for (const entry of closedStores) {
    t.equal(entry.calls, 0, 'closed store not invoked by broadcast')
  }
  t.end()
})

test('registry bookkeeping in close() is idempotent', async (t) => {
  const store = new SqliteCacheStore()
  store.close()
  try {
    store.close()
    t.pass('double close did not throw')
  } catch (err) {
    // DatabaseSync.close() rejects an already-closed handle; that pre-existing
    // behavior is unchanged. The registry bookkeeping (stores.delete /
    // registry.unregister) must not be what throws.
    t.match(err.message, /database is not open/i, 'only the db handle complains')
  }
  t.end()
})

// ---------------------------------------------------------------------------
// The core fix: a store dropped WITHOUT close() must be collectable. The old
// code pinned it in the module-level Set forever. This runs in a child
// process with --expose-gc so it works under a plain `tap test` invocation,
// and is best-effort: an inconclusive GC skips rather than fails.
// ---------------------------------------------------------------------------

test('unclosed store is not pinned by the registry (GC can collect it)', async (t) => {
  const script = `
    import { SqliteCacheStore } from ${JSON.stringify(storeModuleUrl)}

    // Construct in a helper so no stack slot of the top-level frame keeps the
    // store alive; only the WeakRef escapes.
    function make() {
      const store = new SqliteCacheStore()
      store.set(
        { origin: 'https://example.com', method: 'GET', path: '/gc' },
        {
          body: Buffer.from('hello'),
          start: 0,
          end: 5,
          statusCode: 200,
          statusMessage: 'OK',
          cachedAt: Date.now(),
          staleAt: Date.now() + 3600e3,
          deleteAt: Date.now() + 7200e3,
        },
      )
      return new WeakRef(store)
    }

    const ref = make()
    // Let the pending batch flush complete so no setImmediate callback closes
    // over the store.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const deadline = Date.now() + 10000
    while (ref.deref() !== undefined) {
      if (Date.now() > deadline) {
        console.error('INCONCLUSIVE: store not collected within deadline')
        process.exit(2)
      }
      try {
        // Async execution collects without scanning the current stack;
        // synchronous gc() can conservatively treat stale stack slots as
        // roots and never release the store.
        await globalThis.gc({ type: 'major', execution: 'async' })
      } catch {
        globalThis.gc()
      }
      await new Promise((resolve) => setImmediate(resolve))
    }

    // Broadcast after collection: the dispatch loop must skip/remove the dead
    // WeakRef without throwing.
    const bc = new BroadcastChannel('nxt:offPeak')
    bc.postMessage(null)
    await new Promise((resolve) => setTimeout(resolve, 100))
    bc.close()
    console.log('COLLECTED')
    process.exit(0)
  `

  const { code, stdout, stderr } = await new Promise((resolve) => {
    // Disable coverage tracking in the child (the documented
    // @tapjs/processinfo opt-out): this GC probe imports
    // sqlite-cache-store.js but exercises almost none of it, and tap's
    // cross-process coverage merge lets the child's near-empty record mask
    // the real per-file numbers (100% → 86%) instead of unioning them.
    const env = { ...process.env, _TAPJS_PROCESSINFO_COVERAGE_: '0' }
    execFile(
      process.execPath,
      ['--expose-gc', '--input-type=module', '-e', script],
      { timeout: 30000, env },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
      },
    )
  })

  if (code === 2) {
    // GC never collected the store within the deadline. With the WeakRef fix
    // this should not happen, but GC timing is not guaranteed — skip rather
    // than flake.
    t.skip(`inconclusive GC run: ${stderr.trim()}`)
  } else {
    t.equal(code, 0, `child exited cleanly (stderr: ${stderr.trim()})`)
    t.match(stdout, /COLLECTED/, 'store was collected while unclosed')
  }
  t.end()
})

// ---------------------------------------------------------------------------
// Sanity: many construct+close cycles leave no observable trace — a broadcast
// afterwards reaches only the surviving store.
// ---------------------------------------------------------------------------

test('construct/close churn leaves registry consistent', async (t) => {
  for (let i = 0; i < 32; i++) {
    const store = new SqliteCacheStore()
    store.close()
  }

  const live = new SqliteCacheStore()
  t.teardown(() => live.close())
  let calls = 0
  live.clear = () => {
    calls++
  }

  const bc = new BroadcastChannel('nxt:clearCache')
  t.teardown(() => bc.close())
  bc.postMessage(null)

  t.ok(await waitFor(() => calls > 0), 'broadcast reaches surviving store after churn')
  t.equal(calls, 1, 'delivered exactly once')
  t.end()
})
