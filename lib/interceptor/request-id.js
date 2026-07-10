import { parseHeaders } from '../utils.js'

// https://github.com/fastify/fastify/blob/main/lib/reqIdGenFactory.js
// 2,147,483,647 (2^31 − 1) stands for max SMI value (an internal optimization of V8).
// With this upper bound, if you'll be generating 1k ids/sec, you're going to hit it in ~25 days.
// This is very likely to happen in real-world applications, hence the limit is enforced.
// Growing beyond this value will make the id generation slower and cause a deopt.
// In the worst cases, it will become a float, losing accuracy.
const maxInt = 2147483647
let nextReqId = Math.floor(Math.random() * maxInt)
function genReqId() {
  nextReqId = (nextReqId + 1) & maxInt
  return `req-${nextReqId.toString(36)}`
}

export default () => (dispatch) => (opts, handler) => {
  // The standalone interceptor accepts the same object/flat-array header
  // shapes as undici. Normalize first so mixed-case or array-form request-id
  // fields participate in the parent chain instead of being duplicated or
  // replaced by an unrelated id.
  const headers = parseHeaders(opts.headers)

  // Treat an empty string the same as absent in BOTH the selection and the
  // chaining test (the old `??`-vs-truthy split kept a falsy opts.id, skipped
  // the request-id header fallback, then dropped it anyway — losing a real
  // parent id and breaking trace correlation).
  let prevId = opts.id
  if (prevId == null || prevId === '') {
    prevId = headers['request-id']
  }
  const nextId = prevId != null && prevId !== '' ? `${prevId},${genReqId()}` : genReqId()
  return dispatch(
    {
      ...opts,
      id: nextId,
      logger: opts.logger?.child({ ureq: { id: nextId } }),
      headers: { ...headers, 'request-id': nextId },
    },
    handler,
  )
}
