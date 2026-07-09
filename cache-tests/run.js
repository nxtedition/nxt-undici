/* eslint-disable */
// Native nxt-undici runner for the http-tests/cache-tests RFC 9111
// conformance suite (nxtedition/nxt-undici#56).
//
// Usage:
//   node cache-tests/run.js                 run everything, verbose failures
//   node cache-tests/run.js --ci            quiet; exit 1 on unexpected
//                                           required-kind failures
//   node cache-tests/run.js --suite=partial run one suite (comma-separated ids)
//   node cache-tests/run.js --id=<test-id>  run a single test with wire dump
//   node cache-tests/run.js --json          print the raw results object
//
// Result semantics follow upstream lib/results.mjs: only `kind: required`
// (or kind-less) test failures are conformance FAILURES; `optimal` failures
// and `check` "no"s are informational. Expected failures live in
// known-failures.json with a reason each; CI fails on any required failure
// not listed there (and reports stale entries that now pass).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import undici from '@nxtedition/undici'
import { compose, interceptors, cache as cacheExports } from '../lib/index.js'
import { createTestServer } from './engine/server.js'
import { makeTest, rawRequest } from './engine/client.js'
import { determineTestResult, resultTypes } from './engine/lib/results.mjs'
import suites from './tests/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CHUNK_SIZE = 25 // matches upstream runner.mjs default

function parseArgs(argv) {
  const args = { ci: false, json: false, id: null, suite: null, heuristic: false }
  for (const arg of argv) {
    if (arg === '--ci') args.ci = true
    else if (arg === '--json') args.json = true
    else if (arg === '--heuristic') args.heuristic = true
    else if (arg.startsWith('--id=')) args.id = arg.slice(5)
    else if (arg.startsWith('--suite=')) args.suite = arg.slice(8).split(',')
    else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return args
}

function shouldSkip(test) {
  // cdn_only: RFC 9213 CDN-Cache-Control semantics — not a CDN cache.
  if (test.cdn_only === true) return 'cdn_only'
  // browser_only: private browser-cache semantics (private overriding
  // s-maxage, fetch cache modes) — this is a shared client-library cache.
  if (test.browser_only === true) return 'browser_only'
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  let suitesToRun = suites
  if (args.suite) {
    suitesToRun = suites.filter((s) => args.suite.includes(s.id))
    if (suitesToRun.length === 0) {
      console.error(
        `No suites match ${args.suite}. Available: ${suites.map((s) => s.id).join(', ')}`,
      )
      process.exit(2)
    }
  }

  const known = JSON.parse(readFileSync(join(__dirname, 'known-failures.json'), 'utf8'))
  const knownFailures = known.failures ?? {}
  const knownSetupFailures = known.setupFailures ?? {}

  const serverHandle = createTestServer()
  const baseUrl = await serverHandle.listen()

  const store = new cacheExports.SqliteCacheStore({ location: ':memory:' })
  const agent = new undici.Agent()
  const dispatch = compose(agent, interceptors.cache())
  const cacheOpts = args.heuristic ? { store, heuristic: true } : { store }
  const ctx = { baseUrl, dispatch, cacheOpts }

  // Flatten, filter, run in chunks of CHUNK_SIZE concurrently (upstream
  // runSome). Each test is fully isolated by its uuid'd URL.
  const testArray = []
  const skipped = {}
  for (const suite of suitesToRun) {
    for (const test of suite.tests) {
      if (test.id === undefined) throw new Error('Missing test id')
      if (args.id != null) {
        if (test.id === args.id) {
          testArray.push({ ...test, dump: true })
        }
        continue
      }
      const skip = shouldSkip(test)
      if (skip) {
        skipped[test.id] = skip
        continue
      }
      testArray.push(test)
    }
  }

  if (args.id != null && testArray.length === 0) {
    console.error(`No test with id ${args.id}`)
    process.exit(2)
  }

  const results = {}
  for (let index = 0; index < testArray.length; index += CHUNK_SIZE) {
    const chunk = testArray.slice(index, index + CHUNK_SIZE)
    await Promise.all(
      chunk.map(async (test) => {
        const result = await makeTest(test, ctx)
        if (test.id in results) throw new Error(`Duplicate test ${test.id}`)
        results[test.id] = result
      }),
    )
    if (!args.ci) {
      process.stderr.write(
        `\r${Math.min(index + CHUNK_SIZE, testArray.length)}/${testArray.length} tests done`,
      )
    }
  }
  if (!args.ci && testArray.length) process.stderr.write('\n')

  await serverHandle.close()
  await agent.close()

  if (args.json) {
    console.log(JSON.stringify(results, null, 2))
  }
  // With --json, stdout carries ONLY the results object so tooling can parse
  // it; all human-readable reporting below moves to stderr.
  const print = args.json ? console.error : console.log

  // Classify with upstream determineTestResult (honorDependencies=false, like
  // undici's runner: a dependency failure already fails on its own).
  const stats = {
    passed: [],
    failed: [],
    optionalFailed: [],
    checkNo: [],
    setup: [],
    harness: [],
    retried: [],
    skipped: Object.keys(skipped).length,
  }
  // makeTest returns [err.name, err.message] for every caught error, and the
  // vendored determineTestResult only maps 'AbortError' (and literal false) to
  // harness_fail — so an internal runner bug (TypeError etc.) would otherwise
  // masquerade as an ordinary test verdict (a "no" on check-kind, a FAIL on
  // required-kind). Reclassify those here; results.mjs stays verbatim.
  const INTERNAL_ERRORS = new Set(['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'])
  for (const test of testArray) {
    let symbol = determineTestResult(suites, test.id, results, false)
    const raw = results[test.id]
    if (Array.isArray(raw) && INTERNAL_ERRORS.has(raw[0])) {
      symbol = resultTypes.harness_fail
    }
    const detail = Array.isArray(results[test.id]) ? results[test.id].join(': ') : ''
    switch (symbol) {
      case resultTypes.pass:
      case resultTypes.yes:
        stats.passed.push(test.id)
        break
      case resultTypes.fail:
        stats.failed.push([test.id, detail])
        break
      case resultTypes.optional_fail:
        stats.optionalFailed.push([test.id, detail])
        break
      case resultTypes.no:
        stats.checkNo.push([test.id, detail])
        break
      case resultTypes.setup_fail:
        stats.setup.push([test.id, detail])
        break
      case resultTypes.retry:
        stats.retried.push([test.id, detail])
        break
      default:
        stats.harness.push([test.id, detail])
        break
    }
  }

  const unexpectedFailures = stats.failed.filter(([id]) => !(id in knownFailures))
  const expectedFailures = stats.failed.filter(([id]) => id in knownFailures)
  const unexpectedSetup = stats.setup.filter(([id]) => !(id in knownSetupFailures))
  // Only a genuine pass makes a known-failure entry stale — a setup/harness
  // failure or retry is not "now passing".
  const passedSet = new Set(stats.passed)
  const staleKnown = [...Object.keys(knownFailures), ...Object.keys(knownSetupFailures)].filter(
    (id) => passedSet.has(id),
  )

  const total = testArray.length
  const pct = (n) => (total ? `${((100 * n) / total).toFixed(1)}%` : '-')

  if (!args.ci || args.id != null) {
    const printGroup = (title, list) => {
      if (!list.length) return
      print(`\n${title}:`)
      for (const [id, detail] of list) {
        print(`  ${id}${detail ? ` — ${detail}` : ''}`)
      }
    }
    printGroup('FAILED (required)', stats.failed)
    printGroup('failed (optimal, informational)', stats.optionalFailed)
    printGroup('check = no (informational)', stats.checkNo)
    printGroup('setup failures', stats.setup)
    printGroup('harness failures', stats.harness)
    printGroup('retried', stats.retried)
  } else {
    for (const [id, detail] of unexpectedFailures) {
      print(`FAILED: ${id} — ${detail}`)
    }
    for (const [id, detail] of unexpectedSetup) {
      print(`SETUP-FAILED (new): ${id} — ${detail}`)
    }
  }

  print(`
== cache-tests summary ==
  total run:        ${total} (skipped ${stats.skipped}: cdn_only/browser_only)
  passed:           ${stats.passed.length} (${pct(stats.passed.length)})
  failed (required):${String(stats.failed.length).padStart(2)} (${pct(stats.failed.length)}) — ${expectedFailures.length} known, ${unexpectedFailures.length} unexpected
  failed (optimal): ${stats.optionalFailed.length} (${pct(stats.optionalFailed.length)})
  check "no":       ${stats.checkNo.length} (${pct(stats.checkNo.length)})
  setup failures:   ${stats.setup.length}
  harness failures: ${stats.harness.length}
  retried:          ${stats.retried.length}`)

  if (staleKnown.length) {
    print(
      `\nWARNING: known-failures entries that now pass (remove them):\n  ${staleKnown.join('\n  ')}`,
    )
  }

  if (unexpectedFailures.length) {
    print(`\n${unexpectedFailures.length} unexpected required-kind failure(s).`)
    process.exitCode = 1
  }
  // A setup failure means the test was NOT verified. The baselined ones are
  // known N/A behaviors; anything beyond the baseline is drift (e.g. a
  // storability regression silently turning fail-verdicts into setup skips)
  // and must not go green.
  if (!args.suite && !args.id && unexpectedSetup.length) {
    print(`\n${unexpectedSetup.length} setup failure(s) outside the baseline.`)
    process.exitCode = 1
  }
  // Harness failures are bugs in THIS runner (or timeouts) and a run where
  // nothing passed means the harness never actually verified anything — both
  // must fail CI even with zero "unexpected" conformance failures.
  if (stats.harness.length) {
    print(`\n${stats.harness.length} harness failure(s).`)
    process.exitCode = 1
  }
  if (total > 0 && stats.passed.length === 0) {
    print('\nNo test passed — harness sanity check failed.')
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
