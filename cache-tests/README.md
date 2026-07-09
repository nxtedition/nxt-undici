# HTTP cache conformance tests

Native runner for Mark Nottingham's [http-tests/cache-tests](https://github.com/http-tests/cache-tests)
RFC 9111 conformance suite (the same suite `nodejs/undici` runs), driving this
fork's cache interceptor directly — no `fetch`, no browser
(nxtedition/nxt-undici#56).

## Running

```sh
npm run test:cache-tests            # CI mode: quiet, exit 1 on unexpected required failures
node cache-tests/run.js             # verbose: every non-pass with its assertion message
node cache-tests/run.js --suite=partial,stale
node cache-tests/run.js --id=freshness-max-age   # single test + full wire dump
node cache-tests/run.js --heuristic # opt-in heuristic-freshness environment
node cache-tests/run.js --json      # raw per-test results object
```

## Layout

- `tests/` — the 25 declarative test suites + `tests/lib/`, vendored **verbatim**
  from upstream. Do not edit; re-vendor by copying over.
- `engine/lib/` — upstream's `test-engine/lib` result/assert/date helpers
  (`defines.mjs`, `header-fixup.mjs`, `utils.mjs`, `results.mjs`), also
  vendored verbatim (both directories are eslint-ignored for this reason).
- `engine/server.js` — port of the upstream origin server (`/config/{uuid}`,
  `/test/{uuid}`, `/state/{uuid}` routes; templated dates, interim responses,
  conditional 304s, the synthetic 999 "should have been conditional" status).
- `engine/client.js` — port of the upstream client checks, driving
  `compose(new undici.Agent(), interceptors.cache())` through a raw dispatch
  handler with per-request `cache: { store }`. One shared SQLite `:memory:`
  store per run; tests are isolated by their per-test UUID URL, like upstream.
- `run.js` — orchestrator: chunked concurrency (25, like upstream), result
  classification, known-failures gates.
- `known-failures.json` — the CI baseline: `failures` (expected required-kind
  failures, currently **empty** — zero conformance failures in both the
  default and `--heuristic` environments; undici, for comparison, skip-lists
  15+ tests) and `setupFailures` (tests whose _preconditions_ this cache
  deliberately doesn't meet, i.e. N/A — each with a reason). CI fails on any
  required failure or setup failure outside the baseline, on any harness
  failure, or on a run where nothing passed; it warns about stale entries
  that now pass.

Vendored from upstream commit `b555b8d8d13950aaffa396689d38177b3de66bcf`
(2026-06-23). To re-vendor: copy `tests/` and the four `test-engine/lib`
files over, re-run, and update this pin.

## Result semantics (upstream's, unchanged)

| kind (per test)     | on failure                 | gates CI? |
| ------------------- | -------------------------- | --------- |
| `required` / absent | conformance FAILURE        | yes       |
| `optimal`           | "an optimal cache would…"  | no        |
| `check`             | behaviour probe (yes/no)   | no        |
| setup failure       | precondition not met (N/A) | no        |

Skipped statically: `cdn_only` (RFC 9213 CDN semantics) and `browser_only`
(private browser-cache semantics; this is a shared client-library cache).

## Deviations from the upstream fetch runner

- Requests go through a raw dispatch handler, so no fetch-cache-defeating
  header hacks are needed and 1xx interim responses are observable directly.
- A transport-level failure satisfies `expected_status: null` ("no response at
  all", the `stale-close-*` family) instead of aborting the test — the fetch
  runner cannot express this and undici skip-lists those tests.
- `redirect: 'manual'` is a no-op: the raw pipeline never follows redirects.

## Known informational non-passes (by design)

These fail only `optimal`/`check` kinds and are deliberate decisions of this
fork, not bugs:

- **Statuses**: only 200/206/307 are storable (`status-*-fresh`,
  `heuristic-<status>-cached` for other statuses). Heuristically extending
  e.g. 404/301 without origin consent is declined by design.
- **Heuristic freshness** is opt-in (`cache: { heuristic: true }`); the default
  environment reports those as not cached. `--heuristic` validates the opt-in
  path (also zero required failures).
- **Vary normalisation** (`vary-normalise-*`): variant matching is exact
  byte-compare, no value normalisation.
- **Range slicing** (`partial-store-*`): stored 206 windows are served only on
  byte-exact window matches; no slicing of wider entries, no suffix
  (`bytes=-N`) or multi-range parsing — those forward to the origin
  (`lib/interceptor/cache/index.js` "enable range requests" TODO). The safe half of
  the contract is locked in by `test/cache-range.js`.
- **Set-Cookie responses are never stored** (`other-set-cookie`,
  `headers-store-Set-Cookie`): shared-cache decision.
- **HEAD is keyed separately from GET** (`head-*` update/retain tests).
- **Strict HTTP-date parsing** rejects weekday-inconsistent dates (the suite's
  `freshness-expires-ansi-c` literal says `Thu` for a Monday) and wrong-case
  variants, matching upstream undici's parser strictness.
- **Stale on 5xx/disconnect without `stale-if-error`** (`stale-503`,
  `stale-close`, `stale-warning-*`): RFC 5861 windows are honoured exactly;
  no charity beyond them.
