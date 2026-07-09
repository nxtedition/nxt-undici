/* eslint-disable */
// Port of http-tests/cache-tests test-engine/client (test.mjs, fetching.mjs,
// utils.mjs) driving nxt-undici's cache interceptor through a raw dispatch
// function instead of fetch. Check logic is kept line-for-line faithful to
// upstream so re-vendoring stays a diff; the fetch-Response surface is
// replaced by TestResponse (status/headers.get/has + buffered body).
//
// Deliberate deviations from the upstream fetch client:
// - No `cache: 'no-store'` / `Pragma: foo` / `Cache-Control: nothing-to-see-here`
//   request-header hacks: those defeat fetch's own HTTP cache when testing a
//   proxy; here the cache under test IS the client cache (browserCache mode).
// - A request that fails at the transport level (server disconnect) satisfies
//   `expected_status: null` ("no response at all") instead of aborting the
//   test. The upstream fetch runner cannot express this and undici skip-lists
//   the stale-close-* tests because of it.
// - Requests carry a 10s deadline via the dispatch abort callback (upstream
//   uses AbortController + fetch).
//
// Upstream: https://github.com/http-tests/cache-tests @ b555b8d
import * as defines from './lib/defines.mjs'
import { fixupHeader } from './lib/header-fixup.mjs'
import * as utils from './lib/utils.mjs'

const assert = utils.assert

const REQUEST_TIMEOUT = 10_000 // ms, matches upstream config.requestTimeout

export function pause() {
  return new Promise((resolve) => setTimeout(resolve, 3000))
}

// Let the cache store's batched writes land before the next request in the
// sequence reads them (SqliteCacheStore flushes on setImmediate).
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

class TestResponse {
  constructor(statusCode, headers, bodyText, interimResponses) {
    this.status = statusCode
    this.statusText = ''
    this.rawHeaders = headers // lowercased keys; string | string[] values
    this.bodyText = bodyText
    this.interimResponses = interimResponses
    this.headers = {
      has: (name) => this.rawHeaders[name.toLowerCase()] !== undefined,
      get: (name) => {
        const value = this.rawHeaders[name.toLowerCase()]
        if (value === undefined) return null
        return Array.isArray(value) ? value.join(', ') : `${value}`
      },
    }
  }

  text() {
    return this.bodyText
  }
}

export function rawRequest(dispatch, opts, { timeout = REQUEST_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let statusCode = null
    let headers = null
    const chunks = []
    const interim = []
    let abortFn = null
    let settled = false

    const timer = setTimeout(() => {
      const err = new Error(`request timed out after ${timeout}ms`)
      err.name = 'AbortError'
      if (abortFn) {
        abortFn(err)
      } else {
        settled = true
        reject(err)
      }
    }, timeout)

    const handler = {
      onConnect(abort) {
        abortFn = abort
      },
      onHeaders(sc, h, resume) {
        if (sc < 200) {
          interim.push([sc, h])
          return true
        }
        statusCode = sc
        headers = h
        return true
      },
      onData(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        return true
      },
      onComplete() {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(
          new TestResponse(
            statusCode,
            headers ?? {},
            Buffer.concat(chunks).toString('utf8'),
            interim,
          ),
        )
      },
      onError(err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    }

    try {
      dispatch(opts, handler)
    } catch (err) {
      handler.onError(err)
    }
  })
}

// Port of fetching.mjs init(): build raw dispatch opts instead of fetch init.
function buildRequestOpts(ctx, uuid, idx, reqConfig, prevRes) {
  let extra = ''
  if ('filename' in reqConfig) {
    extra += `/${reqConfig.filename}`
  }
  if ('query_arg' in reqConfig) {
    extra += `?${reqConfig.query_arg}`
  }
  const path = `/test/${uuid}${extra}`

  const headerList = []
  if ('request_headers' in reqConfig) {
    headerList.push(...reqConfig.request_headers.map((h) => [...h]))
  }
  if ('magic_ims' in reqConfig && reqConfig.magic_ims === true) {
    for (let i = 0; i < headerList.length; i++) {
      const header = headerList[i]
      if (header[0].toLowerCase() === 'if-modified-since') {
        headerList[i] = fixupHeader(header, prevRes ?? {}, reqConfig)
      }
    }
  }
  headerList.push(['Test-ID', reqConfig.id])
  headerList.push(['Req-Num', `${idx + 1}`])

  // Merge into an undici headers object; duplicate names become arrays so the
  // client emits one line per value (matching the definitions' duplicate
  // request_headers entries).
  const headers = {}
  for (const [name, value] of headerList) {
    const key = name.toLowerCase()
    if (headers[key] === undefined) {
      headers[key] = `${value}`
    } else if (Array.isArray(headers[key])) {
      headers[key].push(`${value}`)
    } else {
      headers[key] = [headers[key], `${value}`]
    }
  }

  const opts = {
    origin: ctx.baseUrl,
    path,
    method: reqConfig.request_method ?? 'GET',
    headers,
    cache: ctx.cacheOpts,
  }
  if ('request_body' in reqConfig) {
    opts.body = reqConfig.request_body
  }
  return opts
}

// Port of client/utils.mjs setupCheck()
function setupCheck(reqConfig, memberName) {
  return (
    reqConfig.setup === true ||
    ('setup_tests' in reqConfig && reqConfig.setup_tests.indexOf(memberName) > -1)
  )
}

// Port of fetching.mjs inflateRequests()
function inflateRequests(test) {
  const requests = []
  for (const reqConfig of test.requests) {
    requests.push({ ...reqConfig, name: test.name, id: test.id, dump: test.dump })
  }
  return requests
}

async function putTestConfig(ctx, uuid, requests) {
  const response = await rawRequest(ctx.dispatch, {
    origin: ctx.baseUrl,
    path: `/config/${uuid}`,
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requests),
  })
  if (response.status !== 201) {
    throw new utils.SetupError({
      message: `PUT config resulted in ${response.status}: ${response.text()}`,
    })
  }
}

async function getServerState(ctx, uuid) {
  const response = await rawRequest(ctx.dispatch, {
    origin: ctx.baseUrl,
    path: `/state/${uuid}`,
    method: 'GET',
    headers: {},
  })
  if (response.status === 200) {
    return JSON.parse(response.text())
  }
  return []
}

/**
 * Run a single test definition. Returns `true` on pass or `[errName, message]`
 * on failure — the same result encoding as upstream testResults, consumed by
 * the vendored lib/results.mjs determineTestResult().
 *
 * ctx: { baseUrl, dispatch, cacheOpts, dump? }
 */
export async function makeTest(test, ctx) {
  const uuid = utils.token()
  const requests = inflateRequests(test)
  const responses = []

  try {
    await putTestConfig(ctx, uuid, requests)

    for (let idx = 0; idx < requests.length; idx++) {
      const reqConfig = requests[idx]
      const prevRes = idx > 0 ? responses[idx - 1]?.rawHeaders : undefined
      const opts = buildRequestOpts(ctx, uuid, idx, reqConfig, prevRes)

      if (test.dump === true) {
        logRequest(opts, idx + 1)
      }

      let response
      try {
        response = await rawRequest(ctx.dispatch, opts)
      } catch (err) {
        if ('expected_status' in reqConfig && reqConfig.expected_status === null) {
          // "No response at all" is the expectation (server disconnect that
          // the cache must not paper over) — satisfied by the failure.
          responses.push(null)
          await settle()
          if (reqConfig.pause_after === true) {
            await pause()
          }
          continue
        }
        throw err
      }

      responses.push(response)
      if (test.dump === true) {
        logResponse(response, idx + 1)
      }

      checkResponse(test, requests, idx, response, uuid)

      await settle()
      if (reqConfig.pause_after === true) {
        await pause()
      }
    }

    const serverState = await getServerState(ctx, uuid)
    checkServerRequests(requests, responses, serverState)

    return true
  } catch (err) {
    return [err.name || 'unknown', err.message]
  }
}

// Port of client/test.mjs checkResponse(); response.text() is synchronous
// here (body already buffered), and `uuid` is passed instead of the module
// testUUIDs map.
function checkResponse(test, requests, idx, response, uuid) {
  const reqNum = idx + 1
  const reqConfig = requests[idx]
  const resNum = parseInt(response.headers.get('Server-Request-Count'))

  // catch retries
  if (response.headers.has('Request-Numbers')) {
    const serverRequests = response.headers
      .get('Request-Numbers')
      .split(' ')
      .map((item) => parseInt(item))
    if (serverRequests.length !== new Set(serverRequests).size) {
      assert(true, false, 'retry')
    }
  }

  // check response type
  if ('expected_type' in reqConfig) {
    const typeSetup = setupCheck(reqConfig, 'expected_type')
    if (reqConfig.expected_type === 'cached') {
      if (response.status === 304 && isNaN(resNum)) {
        // some caches will not include the hdr
      } else {
        assert(typeSetup, resNum < reqNum, `Response ${reqNum} does not come from cache`)
      }
    }
    if (reqConfig.expected_type === 'not_cached') {
      assert(typeSetup, resNum === reqNum, `Response ${reqNum} comes from cache`)
    }
  }

  // check response status
  if ('expected_status' in reqConfig) {
    if (reqConfig.expected_status !== null) {
      assert(
        setupCheck(reqConfig, 'expected_status'),
        response.status === reqConfig.expected_status,
        `Response ${reqNum} status is ${response.status}, not ${reqConfig.expected_status}`,
      )
    }
  } else if ('response_status' in reqConfig) {
    assert(
      true, // response status is always setup
      response.status === reqConfig.response_status[0],
      `Response ${reqNum} status is ${response.status}, not ${reqConfig.response_status[0]}`,
    )
  } else if (response.status === 999) {
    // special condition; the server thought it should have received a conditional request.
    assert(
      setupCheck(reqConfig, 'expected_type'),
      false,
      `Request ${reqNum} should have been conditional, but it was not.`,
    )
  } else {
    assert(
      true, // default status is always setup
      response.status === 200,
      `Response ${reqNum} status is ${response.status}, not 200`,
    )
  }

  // check response headers
  if ('expected_response_headers' in reqConfig) {
    const respPresentSetup = setupCheck(reqConfig, 'expected_response_headers')
    reqConfig.expected_response_headers.forEach((header) => {
      if (typeof header === 'string') {
        assert(
          respPresentSetup,
          response.headers.has(header),
          `Response ${reqNum} ${header} header not present.`,
        )
      } else if (header.length > 2) {
        assert(
          respPresentSetup,
          response.headers.has(header[0]),
          `Response ${reqNum} ${header[0]} header not present.`,
        )

        const value = response.headers.get(header[0])
        let msg, condition
        if (header[1] === '=') {
          const expected = response.headers.get(header[2])
          condition = value === expected
          msg = `match ${header[2]} (${expected})`
        } else if (header[1] === '>') {
          const expected = header[2]
          condition = parseInt(value) > expected
          msg = `be bigger than ${expected}`
        } else {
          throw new Error(`Unknown expected-header operator '${header[1]}'`)
        }

        assert(
          respPresentSetup,
          condition,
          `Response ${reqNum} header ${header[0]} is ${value}, should ${msg}`,
        )
      } else {
        const expectedValue = fixupHeader([...header], response.rawHeaders, reqConfig)[1]
        assert(
          respPresentSetup,
          response.headers.get(header[0]) === `${expectedValue}`,
          `Response ${reqNum} header ${header[0]} is "${response.headers.get(header[0])}", not "${expectedValue}"`,
        )
      }
    })
  }
  if ('expected_response_headers_missing' in reqConfig) {
    const respMissingSetup = setupCheck(reqConfig, 'expected_response_headers_missing')
    reqConfig.expected_response_headers_missing.forEach((header) => {
      if (typeof header === 'string') {
        assert(
          respMissingSetup,
          !response.headers.has(header),
          `Response ${reqNum} includes unexpected header ${header}: "${response.headers.get(header)}"`,
        )
      } else if (header.length === 2) {
        if (response.headers.has(header[0])) {
          const hdrValue = response.headers.get(header[0])
          assert(
            respMissingSetup,
            hdrValue.indexOf(header[1]) === -1,
            `Response ${reqNum} header ${header[0]} still has value "${hdrValue}"`,
          )
        }
      } else {
        throw new Error(`Unknown unexpected-header form '${header}'`)
      }
    })
  }

  // check interim responses
  if ('expected_interim_responses' in reqConfig) {
    const isSetup = setupCheck(reqConfig, 'expected_interim_responses')
    const interimResponses = response.interimResponses

    reqConfig.expected_interim_responses.forEach(([statusCode, headers = []], i) => {
      if (interimResponses[i] == null) {
        assert(isSetup, false, `Interim response ${i + 1} not received`)
      } else {
        assert(
          isSetup,
          interimResponses[i][0] === statusCode,
          `Interim response ${i + 1} status is ${interimResponses[i][0]}, not ${statusCode}`,
        )

        const receivedHeaders = interimResponses[i][1]
        // Presence-only, matching upstream's EFFECTIVE behavior: its
        // value-comparison branch (test.mjs:214-220) requires a non-string
        // header entry and is unreachable for the actual definitions, so the
        // reference harness never verifies interim header values. Asserting
        // values here could flip verdicts vs. the reference.
        headers.forEach(([header]) => {
          assert(
            isSetup,
            receivedHeaders[header.toLowerCase()] !== undefined,
            `Interim response ${i + 1} ${header} header not present.`,
          )
        })
      }
    })

    assert(
      isSetup,
      interimResponses.length === reqConfig.expected_interim_responses.length,
      `Received ${interimResponses.length} interim response(s), expected ${reqConfig.expected_interim_responses.length}`,
    )
  }

  checkResponseBody(test, reqConfig, response.status, response.text(), uuid)
}

// Port of client/test.mjs makeCheckResponseBody()
function checkResponseBody(test, reqConfig, statusCode, resBody, uuid) {
  if ('check_body' in reqConfig && reqConfig.check_body === false) {
    return
  } else if ('expected_response_text' in reqConfig) {
    if (reqConfig.expected_response_text !== null) {
      assert(
        setupCheck(reqConfig, 'expected_response_text'),
        resBody === reqConfig.expected_response_text,
        `Response body is "${resBody}", not "${reqConfig.expected_response_text}"`,
      )
    }
  } else if ('response_body' in reqConfig && reqConfig.response_body !== null) {
    assert(
      true, // response_body is always setup
      resBody === reqConfig.response_body,
      `Response body is "${resBody}", not "${reqConfig.response_body}"`,
    )
  } else if (!defines.noBodyStatus.has(statusCode) && reqConfig.request_method !== 'HEAD') {
    assert(
      true, // no_body is always setup
      resBody === uuid,
      `Response body is "${resBody}", not "${uuid}"`,
    )
  }
}

// Port of client/test.mjs checkServerRequests(). Responses may contain null
// placeholders (expected transport failures) — guarded where upstream's fetch
// runner could never get that far.
function checkServerRequests(requests, responses, serverState) {
  let testIdx = 0
  for (let i = 0; i < requests.length; ++i) {
    const expectedValidatingHeaders = []
    const reqConfig = requests[i]
    const response = responses[i]
    const serverRequest = serverState[testIdx]
    const reqNum = i + 1
    const typeSetup = setupCheck(reqConfig, 'expected_type')
    if ('expected_type' in reqConfig) {
      if (reqConfig.expected_type === 'cached') continue // the server will not see the request
      if (reqConfig.expected_type === 'not_cached') {
        assert(
          typeSetup,
          serverRequest !== undefined && serverRequest.request_num === reqNum,
          `Response ${reqNum} comes from cache (${serverRequest?.request_num} on server)`,
        )
      }
      if (reqConfig.expected_type === 'etag_validated') {
        expectedValidatingHeaders.push('if-none-match')
      }
      if (reqConfig.expected_type === 'lm_validated') {
        expectedValidatingHeaders.push('if-modified-since')
      }
    }
    testIdx++ // only increment for requests the server sees
    expectedValidatingHeaders.forEach((vhdr) => {
      assert(
        typeSetup,
        typeof serverRequest !== 'undefined',
        `request ${reqNum} wasn't sent to server`,
      )
      assert(
        typeSetup,
        Object.prototype.hasOwnProperty.call(serverRequest.request_headers, vhdr),
        `request ${reqNum} doesn't have ${vhdr} header`,
      )
    })
    if ('expected_request_headers' in reqConfig) {
      const reqPresentSetup = setupCheck(reqConfig, 'expected_request_headers')
      reqConfig.expected_request_headers.forEach((header) => {
        if (typeof header === 'string') {
          const headerName = header.toLowerCase()
          assert(
            reqPresentSetup,
            serverRequest !== undefined &&
              Object.prototype.hasOwnProperty.call(serverRequest.request_headers, headerName),
            `Request ${reqNum} ${header} header not present.`,
          )
        } else {
          const reqValue = serverRequest?.request_headers[header[0].toLowerCase()]
          assert(
            reqPresentSetup,
            reqValue === header[1],
            `Request ${reqNum} header ${header[0]} is "${reqValue}", not "${header[1]}"`,
          )
        }
      })
    }
    if ('expected_request_headers_missing' in reqConfig) {
      const reqmPresentSetup = setupCheck(reqConfig, 'expected_request_headers_missing')
      reqConfig.expected_request_headers_missing.forEach((header) => {
        if (typeof header === 'string') {
          const headerName = header.toLowerCase()
          assert(
            reqmPresentSetup,
            serverRequest === undefined ||
              !Object.prototype.hasOwnProperty.call(serverRequest.request_headers, headerName),
            `Request ${reqNum} ${header} header present.`,
          )
        } else {
          const reqValue = serverRequest?.request_headers[header[0].toLowerCase()]
          assert(
            reqmPresentSetup,
            reqValue !== header[1],
            `Request ${reqNum} header ${header[0]} is "${reqValue}"`,
          )
        }
      })
    }
    if (
      response != null &&
      typeof serverRequest !== 'undefined' &&
      'response_headers' in serverRequest
    ) {
      serverRequest.response_headers.forEach((header) => {
        if (defines.skipResponseHeaders.has(header[0].toLowerCase())) {
          // these just cause spurious failures
          return
        }
        let received = response.headers.get(header[0])
        let expected = header[1]
        if (Array.isArray(expected)) {
          expected = expected.join(', ')
        }
        assert(
          true, // default headers is always setup
          received === `${expected}`,
          `Response ${reqNum} header ${header[0]} is "${received}", not "${expected}"`,
        )
      })
    }
    if ('expected_method' in reqConfig) {
      assert(
        setupCheck(reqConfig, 'expected_method'),
        serverRequest !== undefined && serverRequest.request_method === reqConfig.expected_method,
        `Request ${reqNum} had method ${serverRequest?.request_method}, not ${reqConfig.expected_method}`,
      )
    }
  }
}

function logRequest(opts, reqNum) {
  console.log(`${defines.GREEN}=== Client request ${reqNum}${defines.NC}`)
  console.log(`    ${opts.method} ${opts.origin}${opts.path}`)
  for (const [name, value] of Object.entries(opts.headers)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      console.log(`    ${name}: ${v}`)
    }
  }
  console.log('')
}

function logResponse(response, reqNum) {
  console.log(`${defines.GREEN}=== Client response ${reqNum}${defines.NC}`)
  for (const [statusCode, headers] of response.interimResponses) {
    console.log(`    HTTP ${statusCode}`)
    for (const [name, value] of Object.entries(headers)) {
      console.log(`    ${name}: ${value}`)
    }
    console.log('')
  }
  console.log(`    HTTP ${response.status}`)
  for (const [name, value] of Object.entries(response.rawHeaders)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      console.log(`    ${name}: ${v}`)
    }
  }
  console.log(`    ${JSON.stringify(response.text())}`)
  console.log('')
}
