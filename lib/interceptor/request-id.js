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

module.exports = (dispatch) => (opts, handler) => {
  let id = opts.id ?? opts.headers?.['request-id'] ?? opts.headers?.['Request-Id']
  id = id ? `${id},${genReqId()}` : genReqId()

  return dispatch(
    {
      ...opts,
      id,
      headers: {
        ...opts.headers,
        'request-id': id,
      },
    },
    handler,
  )
}
