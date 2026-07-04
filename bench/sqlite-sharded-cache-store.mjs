// Benchmark for SqliteShardedCacheStore vs SqliteCacheStore.
//
// Two parts:
//
// 1. Micro (single thread, mitata): overhead of the shard router on get/set.
//    The sharded store should be within noise of the plain store — the URL
//    hash is a few dozen ns against a ~µs sqlite query.
//
// 2. Contention (worker threads, file-backed): W workers share one on-disk
//    cache and run a write-heavy workload (90% set / 10% get) against the
//    same URL pool. With a single database every flush transaction contends
//    on the WAL write lock: workers stall in sqlite's busy handler (blocking
//    their event loop) and drop batches on SQLITE_BUSY. Sharding gives each
//    shard its own write lock, so stalls and drops shrink with shard count.
//
//    Reported per config:
//      ops/s     — issued get+set across workers per wall second (stalls
//                  from busy-waiting directly depress this)
//      busy      — SQLITE_BUSY/LOCKED flush failures (each drops a batch)
//      tick p50/p99/max — event-loop tick duration per worker iteration;
//                  busy waits show up as multi-ms p99/max
//      close(ms) — worst per-worker close() drain time
//      rows      — entries landed. Roughly the URL pool size; concurrently
//                  interleaved writers leave newest-wins duplicates behind
//                  (reclaimed by gc), so a noticeably higher value is itself
//                  a contention artifact.
//
//    Where the trade sits (measured on an M-series laptop): with few workers
//    and small bodies the WAL write lock is held so briefly that collisions
//    are rare, and sharding's extra per-shard transactions make it a net
//    loss on ops/s — while still eliminating busy drops. With more writers
//    and/or larger bodies (longer lock hold) the plain store degrades into
//    20ms busy-timeout stalls and dropped batches, and sharding wins on
//    every column. Defaults target the contended regime.
//
// Usage:
//   node bench/sqlite-sharded-cache-store.mjs                # both parts
//   node bench/sqlite-sharded-cache-store.mjs --micro-only
//   node bench/sqlite-sharded-cache-store.mjs --contention-only
//   node bench/sqlite-sharded-cache-store.mjs --workers=4 --duration=2000 \
//     --urls=2048 --body=4096 --ops-per-tick=32

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { setImmediate as yieldTick } from 'node:timers/promises'
import { SqliteCacheStore } from '../lib/sqlite-cache-store.js'
import { SqliteShardedCacheStore } from '../lib/sqlite-sharded-cache-store.js'

const BENCH_ORIGIN = 'https://bench.local'

function makeStore({ storeType, shards, location }) {
  return storeType === 'sharded'
    ? new SqliteShardedCacheStore({ location, shards })
    : new SqliteCacheStore({ location })
}

// Opening the same file from many threads at once can hit SQLITE_BUSY during
// the one-time schema setup (the WAL conversion takes an exclusive lock) —
// the store's default 20ms busy timeout is tuned for runtime, not for a
// same-millisecond cold start. The main thread pre-creates the schema, and
// workers additionally retry construction with a bounded deadline. Runtime
// behavior stays on the defaults, which is what the benchmark measures.
async function makeStoreWithRetry(config, deadlineMs = 10_000) {
  const started = performance.now()
  for (;;) {
    try {
      return makeStore(config)
    } catch (err) {
      if ((err?.errcode === 5 || err?.errcode === 6) && performance.now() - started < deadlineMs) {
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40))
      } else {
        throw err
      }
    }
  }
}

function makeKey(url) {
  return { origin: BENCH_ORIGIN, method: 'GET', path: `/r/${url}` }
}

function makeValue(body) {
  const now = Date.now()
  return {
    body,
    start: 0,
    end: body.byteLength,
    statusCode: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'application/octet-stream' },
    cachedAt: now,
    staleAt: now + 60e3,
    deleteAt: now + 120e3,
  }
}

// ---------------------------------------------------------------------------
// Worker: write-heavy workload against a shared store location
// ---------------------------------------------------------------------------

async function workerMain() {
  const { storeType, shards, location, durationMs, urls, bodySize, opsPerTick, seed } = workerData

  let busy = 0
  let otherSqliteWarnings = 0
  process.on('warning', (warning) => {
    if (warning?.code !== 'ERR_SQLITE_ERROR' && warning?.errcode == null) {
      return // e.g. ExperimentalWarning for node:sqlite
    }
    if (warning.errcode === 5 || warning.errcode === 6 || /busy|locked/i.test(warning.message)) {
      busy++
    } else {
      otherSqliteWarnings++
    }
  })

  const store = await makeStoreWithRetry({ storeType, shards, location })
  const body = Buffer.alloc(bodySize, 0x61)

  // Small deterministic LCG so runs are reproducible per worker.
  let rng = seed >>> 0
  const nextRandom = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
    return rng
  }

  parentPort.postMessage({ type: 'ready' })
  await once(parentPort, 'message') // start signal

  let sets = 0
  let gets = 0
  let hits = 0
  const tickDurations = []
  const started = performance.now()
  const deadline = started + durationMs

  while (performance.now() < deadline) {
    const tickStart = performance.now()
    for (let i = 0; i < opsPerTick; i++) {
      const key = makeKey(nextRandom() % urls)
      if (i % 10 === 9) {
        gets++
        if (store.get(key) !== undefined) {
          hits++
        }
      } else {
        sets++
        store.set(key, makeValue(body))
      }
    }
    // Yield one macrotask so the store's batched flush runs — this is where
    // write contention bites (busy waits block the whole tick).
    await yieldTick()
    tickDurations.push(performance.now() - tickStart)
  }

  const wallMs = performance.now() - started
  const closeStart = performance.now()
  store.close() // drains the pending batch synchronously
  const closeMs = performance.now() - closeStart

  tickDurations.sort((a, b) => a - b)
  const pct = (p) =>
    tickDurations.length === 0
      ? 0
      : tickDurations[Math.min(tickDurations.length - 1, Math.floor(p * tickDurations.length))]

  parentPort.postMessage({
    type: 'result',
    sets,
    gets,
    hits,
    busy,
    otherSqliteWarnings,
    wallMs,
    closeMs,
    tickP50: pct(0.5),
    tickP99: pct(0.99),
    tickMax: tickDurations[tickDurations.length - 1] ?? 0,
  })
}

// ---------------------------------------------------------------------------
// Main: orchestration
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    worker.on('message', (msg) => {
      if (msg?.type === type) {
        resolve(msg)
      }
    })
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited with code ${code}`))
      }
    })
  })
}

function countLandedRows(config, location) {
  const files =
    config.storeType === 'sharded'
      ? Array.from({ length: config.shards }, (_, i) => `${location}.${i}-${config.shards}`)
      : [location]

  let rows = 0
  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue
    }
    const db = new DatabaseSync(file)
    try {
      const table = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cacheInterceptorV%'`,
        )
        .get()
      if (table) {
        rows += db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get().n
      }
    } finally {
      db.close()
    }
  }
  return rows
}

async function runContentionConfig(config, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharded-cache-bench-'))
  const location = path.join(dir, 'cache.db')

  try {
    // Pre-create the database files and schema so workers don't race the
    // exclusive-locked WAL conversion on cold start.
    makeStore({ storeType: config.storeType, shards: config.shards, location }).close()

    const workers = []
    for (let i = 0; i < opts.workers; i++) {
      workers.push(
        new Worker(new URL(import.meta.url), {
          workerData: {
            storeType: config.storeType,
            shards: config.shards,
            location,
            durationMs: opts.durationMs,
            urls: opts.urls,
            bodySize: opts.bodySize,
            opsPerTick: opts.opsPerTick,
            seed: 0x9e3779b9 + i * 0x85ebca6b,
          },
        }),
      )
    }

    try {
      const readies = workers.map((w) => waitFor(w, 'ready'))
      const results = workers.map((w) => waitFor(w, 'result'))

      await withTimeout(Promise.all(readies), 15_000, `${config.name}: workers ready`)

      const started = performance.now()
      for (const worker of workers) {
        worker.postMessage('start')
      }
      // Grace on top of the run duration covers the final close() drain,
      // which serializes on the contended write lock in the worst case.
      const collected = await withTimeout(
        Promise.all(results),
        opts.durationMs + 30_000,
        `${config.name}: workers done`,
      )
      const wallMs = performance.now() - started

      await Promise.all(workers.map((w) => w.terminate()))

      const sum = (fn) => collected.reduce((acc, r) => acc + fn(r), 0)
      const max = (fn) => collected.reduce((acc, r) => Math.max(acc, fn(r)), 0)

      return {
        name: config.name,
        wallMs,
        ops: sum((r) => r.sets + r.gets),
        sets: sum((r) => r.sets),
        gets: sum((r) => r.gets),
        hits: sum((r) => r.hits),
        busy: sum((r) => r.busy),
        otherSqliteWarnings: sum((r) => r.otherSqliteWarnings),
        tickP50: max((r) => r.tickP50),
        tickP99: max((r) => r.tickP99),
        tickMax: max((r) => r.tickMax),
        closeMs: max((r) => r.closeMs),
        rows: countLandedRows(config, location),
      }
    } finally {
      // Belt and braces: never leave threads behind, even on timeout.
      await Promise.all(workers.map((w) => w.terminate().catch(() => {})))
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function formatNumber(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
}

function printContentionTable(results, opts) {
  const columns = [
    ['config', (r) => r.name],
    ['ops/s', (r) => formatNumber(Math.round((r.ops / r.wallMs) * 1000))],
    ['sets', (r) => formatNumber(r.sets)],
    ['hit%', (r) => `${((r.hits / Math.max(1, r.gets)) * 100).toFixed(0)}%`],
    ['busy', (r) => String(r.busy)],
    ['tick p50', (r) => `${r.tickP50.toFixed(2)}ms`],
    ['tick p99', (r) => `${r.tickP99.toFixed(2)}ms`],
    ['tick max', (r) => `${r.tickMax.toFixed(1)}ms`],
    ['close max', (r) => `${r.closeMs.toFixed(1)}ms`],
    ['rows', (r) => formatNumber(r.rows)],
  ]

  const rows = results.map((r) => columns.map(([, fn]) => (r.error ? `error: ${r.error}` : fn(r))))
  const widths = columns.map(([header], i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length)),
  )

  console.log(
    `\ncontention: ${opts.workers} workers x ${opts.durationMs}ms, ` +
      `${opts.urls} urls, ${opts.bodySize}B bodies, ${opts.opsPerTick} ops/tick (90% set)\n`,
  )
  console.log(columns.map(([header], i) => header.padEnd(widths[i])).join('  '))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join('  '))
  }

  const plain = results.find((r) => r.name === 'plain' && !r.error)
  if (plain) {
    console.log('')
    for (const r of results) {
      if (r === plain || r.error) {
        continue
      }
      const speedup = r.ops / r.wallMs / (plain.ops / plain.wallMs)
      console.log(`${r.name}: ${speedup.toFixed(2)}x ops/s vs plain`)
    }
  }
}

async function runContention(opts) {
  const configs = [
    { name: 'plain', storeType: 'plain' },
    { name: 'sharded-2', storeType: 'sharded', shards: 2 },
    { name: 'sharded-4', storeType: 'sharded', shards: 4 },
    { name: 'sharded-8', storeType: 'sharded', shards: 8 },
  ]

  const results = []
  for (const config of configs) {
    process.stdout.write(`running ${config.name}...\n`)
    try {
      results.push(await runContentionConfig(config, opts))
    } catch (err) {
      results.push({ name: config.name, error: err.message })
    }
  }

  printContentionTable(results, opts)
}

// ---------------------------------------------------------------------------
// Main: micro benchmark (single thread overhead of the shard router)
// ---------------------------------------------------------------------------

async function runMicro() {
  const { run, bench, group } = await import('mitata')

  const URLS = 256
  const keys = Array.from({ length: URLS }, (_, i) => makeKey(i))
  const body = Buffer.alloc(16, 0x61)

  const plain = new SqliteCacheStore()
  const sharded = new SqliteShardedCacheStore({ shards: 4 })

  for (const store of [plain, sharded]) {
    for (const key of keys) {
      store.set(key, makeValue(body))
    }
  }
  await yieldTick() // flush both stores so get() takes the fast path

  let i = 0
  let j = 0
  group('get (hit, 256 urls)', () => {
    bench('plain', () => plain.get(keys[i++ % URLS])).baseline(true)
    bench('sharded(4)', () => sharded.get(keys[j++ % URLS]))
  })

  // A single hot key coalesces in the pending batch, so this measures the
  // set() enqueue path (assert + batch scan) plus the router, not sqlite.
  const hotKey = makeKey('hot')
  group('set (hot key, coalesced enqueue)', () => {
    bench('plain', () => plain.set(hotKey, makeValue(body))).baseline(true)
    bench('sharded(4)', () => sharded.set(hotKey, makeValue(body)))
  })

  await run({ colors: false })

  plain.close()
  sharded.close()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (!isMainThread) {
  await workerMain()
} else {
  const flag = (name, fallback) => {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
    return arg ? Number(arg.slice(name.length + 3)) : fallback
  }

  const opts = {
    workers: flag('workers', 8),
    durationMs: flag('duration', 3000),
    urls: flag('urls', 1024),
    bodySize: flag('body', 16384),
    opsPerTick: flag('ops-per-tick', 32),
  }

  const microOnly = process.argv.includes('--micro-only')
  const contentionOnly = process.argv.includes('--contention-only')

  if (!contentionOnly) {
    await runMicro()
  }
  if (!microOnly) {
    await runContention(opts)
  }
}
