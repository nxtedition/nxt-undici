/* eslint-disable */
// Port of http-tests/cache-tests test-engine/server (handle-test.mjs,
// handle-config.mjs, handle-state.mjs, utils.mjs) for the native nxt-undici
// runner. Logic is kept line-for-line faithful to upstream where possible so
// re-vendoring stays a diff, with two adaptations: state is instance-scoped
// (no module globals) and the server listens on an ephemeral port.
//
// Upstream: https://github.com/http-tests/cache-tests @ b555b8d
import { createServer } from 'node:http'
import { noBodyStatus } from './lib/defines.mjs'
import { fixupHeader } from './lib/header-fixup.mjs'

export function createTestServer({ logger = null } = {}) {
  // stash for server state (uuid -> array of observed requests)
  const stash = new Map()
  // configurations (uuid -> requests array)
  const configs = new Map()

  function sendResponse(response, statusCode, message) {
    logger?.(`SERVER WARNING: ${message}`)
    response.writeHead(statusCode, { 'Content-Type': 'text/plain' })
    response.write(`${message}\n`)
    response.end()
  }

  function getHeader(headers, headerName) {
    let result
    headers.forEach((header) => {
      if (header[0].toLowerCase() === headerName.toLowerCase()) {
        result = header[1]
      }
    })
    return result
  }

  function handleConfig(pathSegs, request, response) {
    const uuid = pathSegs[0]
    if (request.method !== 'PUT') {
      sendResponse(response, 405, `${request.method} request to config for ${uuid}`)
      return
    }
    if (configs.has(uuid)) {
      sendResponse(response, 409, `Config already exists for ${uuid}`)
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        configs.set(uuid, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        sendResponse(response, 400, `Config parse error: ${err.message}`)
        return
      }
      response.statusCode = 201
      response.end('OK')
    })
  }

  function handleState(pathSegs, request, response) {
    const uuid = pathSegs[0]
    const state = stash.get(uuid)
    if (state === undefined) {
      sendResponse(response, 404, `State not found for ${uuid}`)
      return
    }
    response.setHeader('Content-Type', 'text/plain')
    response.end(JSON.stringify(state))
  }

  function handleTest(pathSegs, request, response) {
    // identify the desired configuration for this request
    const uuid = pathSegs[0]
    if (!uuid) {
      sendResponse(response, 404, `Config Not Found for ${uuid}`)
      return
    }
    const requests = configs.get(uuid)
    if (!requests) {
      sendResponse(response, 409, `Requests not found for ${uuid}`)
      return
    }

    const serverState = stash.get(uuid) || []
    const srvReqNum = serverState.length + 1
    const cliReqNum = parseInt(request.headers['req-num'])
    const reqNum = cliReqNum || srvReqNum
    const reqConfig = requests[reqNum - 1]

    if (!reqConfig) {
      sendResponse(
        response,
        409,
        `${requests[0].id} config not found for request ${srvReqNum} (anticipating ${requests.length})`,
      )
      return
    }

    // response_pause
    if ('response_pause' in reqConfig) {
      setTimeout(
        continueHandleTest,
        reqConfig.response_pause * 1000,
        uuid,
        request,
        response,
        requests,
        serverState,
      )
    } else {
      continueHandleTest(uuid, request, response, requests, serverState)
    }
  }

  function continueHandleTest(uuid, request, response, requests, serverState) {
    const srvReqNum = serverState.length + 1
    const cliReqNum = parseInt(request.headers['req-num'])
    const reqNum = cliReqNum || srvReqNum
    const reqConfig = requests[reqNum - 1]
    const previousConfig = requests[reqNum - 2]
    const now = Date.now()

    const interimResponses = reqConfig.interim_responses || []
    for (const [status, headers = []] of interimResponses) {
      if (status === 102) {
        response.writeProcessing()
      } else if (status === 103) {
        response.writeEarlyHints(Object.fromEntries(headers))
      } else {
        logger?.(`ERROR: Sending ${status} is not yet supported`)
      }
    }

    // Determine what the response status should be
    let httpStatus = reqConfig.response_status || [200, 'OK']
    if ('expected_type' in reqConfig && reqConfig.expected_type.endsWith('validated')) {
      const previousLm = getHeader(previousConfig.response_headers, 'Last-Modified')
      if (previousLm && request.headers['if-modified-since'] === previousLm) {
        httpStatus = [304, 'Not Modified']
      }
      const previousEtag = getHeader(previousConfig.response_headers, 'ETag')
      if (previousEtag && request.headers['if-none-match'] === previousEtag) {
        httpStatus = [304, 'Not Modified']
      }
      if (httpStatus[0] !== 304) {
        httpStatus = [999, '304 Not Generated']
      }
    }
    response.statusCode = httpStatus[0]
    response.statusMessage = httpStatus[1]

    // header manipulation
    const responseHeaders = reqConfig.response_headers || []
    const savedHeaders = new Map()
    response.setHeader('Server-Base-Url', request.url)
    response.setHeader('Server-Request-Count', srvReqNum)
    response.setHeader('Client-Request-Count', cliReqNum)
    response.setHeader('Server-Now', now)
    responseHeaders.forEach((header) => {
      header = fixupHeader(header, response.getHeaders(), reqConfig)
      if (response.hasHeader(header[0])) {
        const currentVal = response.getHeader(header[0])
        if (typeof currentVal === 'string') {
          response.setHeader(header[0], [currentVal, header[1]])
        } else if (Array.isArray(currentVal)) {
          response.setHeader(header[0], currentVal.concat(header[1]))
        } else {
          logger?.(`ERROR: Unanticipated header type of ${typeof currentVal} for ${header[0]}`)
        }
      } else {
        response.setHeader(header[0], header[1])
      }
      if (header.length < 3 || header[2] === true) {
        savedHeaders.set(header[0], response.getHeader(header[0]))
      }
    })

    if (!response.hasHeader('content-type')) {
      response.setHeader('Content-Type', 'text/plain')
    }

    // stash information about this request for the client
    serverState.push({
      request_num: cliReqNum,
      request_method: request.method,
      request_headers: request.headers,
      response_headers: Array.from(savedHeaders.entries()),
    })
    response.setHeader('Request-Numbers', serverState.map((item) => item.request_num).join(' '))
    stash.set(uuid, serverState)

    // Response body generation
    if ('disconnect' in reqConfig && reqConfig.disconnect) {
      // disconnect now because we want the state
      response.socket.destroy()
    } else if (noBodyStatus.has(response.statusCode)) {
      response.end()
    } else {
      const content = reqConfig.response_body || uuid
      response.end(content)
    }
  }

  const server = createServer((request, response) => {
    // The server runs in-process (upstream forks it); an uncaught handler
    // exception would otherwise take down the whole suite run.
    try {
      const url = new URL(request.url, 'http://localhost/')
      const pathSegs = url.pathname.split('/').filter(Boolean)
      const route = pathSegs.shift()
      if (route === 'config') {
        handleConfig(pathSegs, request, response)
      } else if (route === 'state') {
        handleState(pathSegs, request, response)
      } else if (route === 'test') {
        handleTest(pathSegs, request, response)
      } else {
        sendResponse(response, 404, `Unknown route ${route}`)
      }
    } catch (err) {
      try {
        sendResponse(response, 500, `Server handler error: ${err.stack}`)
      } catch {
        response.destroy()
      }
    }
  })

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          resolve(`http://127.0.0.1:${server.address().port}`)
        })
      })
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      })
    },
  }
}
