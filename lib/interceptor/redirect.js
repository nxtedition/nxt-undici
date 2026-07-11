import assert from 'node:assert'
import {
  buildURL,
  DecoratorHandler,
  invalidateNormalizedHeaders,
  isDisturbed,
  parseHeaders,
  parseURL,
} from '../utils.js'
import { traceWrite, traceSafe, traceUrl } from '../trace.js'

const redirectableStatusCodes = [300, 301, 302, 303, 307, 308]

function isOneShotIterable(body) {
  if (body == null || typeof body !== 'object') {
    return false
  }

  try {
    const asyncIteratorFactory = body[Symbol.asyncIterator]
    const iteratorFactory =
      typeof asyncIteratorFactory === 'function' ? asyncIteratorFactory : body[Symbol.iterator]
    if (typeof iteratorFactory !== 'function') {
      return false
    }

    const iterator = iteratorFactory.call(body)
    return iterator === body || iteratorFactory.call(body) === iterator
  } catch {
    // If asking for another iterator already fails, the body cannot be replayed.
    return true
  }
}

class Handler extends DecoratorHandler {
  #dispatch
  #opts
  #maxCount

  #abort
  #aborted = false
  #reason = null
  #headersSent = false
  #count = 0
  #location
  #history = []

  constructor(opts, { dispatch, handler }) {
    super(handler)

    this.#dispatch = dispatch
    this.#opts = opts
    // `follow: true` means "follow redirects" — map it to the project default
    // cap rather than letting `true.count ?? 0` collapse to 0, which would
    // reject the very first redirect with "Max redirections reached: 0".
    this.#maxCount =
      opts.follow === true
        ? 8
        : Number.isFinite(opts.follow)
          ? opts.follow
          : (opts.follow?.count ?? 0)

    super.onConnect((reason) => {
      this.#aborted = true
      // Always remember the latest reason so it survives a caller abort that
      // lands in the window between one hop completing and the next hop's
      // onConnect; #abort may still point at the finished hop's no-op abort.
      this.#reason = reason
      this.#abort?.(reason)
    })
  }

  onConnect(abort) {
    if (this.#aborted) {
      abort(this.#reason)
    } else {
      this.#abort = abort
    }
  }

  onUpgrade(statusCode, headers, socket) {
    super.onUpgrade(statusCode, headers, socket)
  }

  onHeaders(statusCode, headers, resume) {
    // Informational (1xx, e.g. 100 Continue / 103 Early Hints) responses are
    // interim — not final and not redirects — so forward them through without
    // marking headersSent or counting a redirect hop. Otherwise the
    // `assert(!headersSent)` below trips (turning a good response into an
    // onError) when the real final response arrives after an interim one. This
    // matches the 1xx passthrough already in response-retry and RequestHandler;
    // it is exercised when an inner dispatcher forwards a 1xx (raw undici
    // strips them, but composed/mock dispatchers and future early-hints support
    // do not).
    if (statusCode < 200) {
      return super.onHeaders(statusCode, headers, resume)
    }

    if (redirectableStatusCodes.indexOf(statusCode) === -1) {
      assert(!this.#headersSent)
      this.#headersSent = true
      return super.onHeaders(statusCode, headers, resume)
    }

    this.#location = typeof headers.location === 'string' ? headers.location : ''

    if (!this.#location) {
      throw new Error(`Missing redirection location.`)
    }

    this.#history.push(this.#location)
    this.#count += 1

    if (typeof this.#opts.follow === 'function') {
      // follow() receives the live opts object and may mutate headers. Remove
      // trust before invoking it so the next parseHeaders() call validates any
      // changes instead of taking the identity fast path.
      invalidateNormalizedHeaders(this.#opts.headers)
      if (!this.#opts.follow(this.#location, this.#count, this.#opts)) {
        assert(!this.#headersSent)
        this.#headersSent = true
        this.#location = null
        return super.onHeaders(statusCode, headers, resume)
      }
    } else {
      // `follow: N` follows up to N redirects and errors on the N+1th, matching
      // undici/fetch maxRedirections semantics. `>` (not `>=`): with `>=`,
      // `follow: 1` threw on the very first redirect with a self-contradictory
      // "Max redirections reached: 1." message.
      if (this.#count > this.#maxCount) {
        throw Object.assign(new Error(`Max redirections reached: ${this.#maxCount}.`), {
          history: this.#history,
        })
      }
    }

    // Check replayability only after the follow policy has decided to follow.
    // A callback that returns false delivers this 3xx response as-is and does
    // not need the already-sent request body again.
    if (
      statusCode !== 303 &&
      (isDisturbed(this.#opts.body) || isOneShotIterable(this.#opts.body))
    ) {
      throw new Error(`Disturbed request cannot be redirected.`)
    }

    // The redirect decision is final past this point, so trace work stays off
    // the non-redirect path entirely. Resolve the writer per emission (trace
    // survives the opts spread across hops) and capture `from` before #opts
    // is rebuilt below.
    const write = traceWrite(this.#opts.trace)
    const from = write !== null ? traceUrl(this.#opts) : null

    // Build the base URL by concatenating origin + path via buildURL rather
    // than `new URL(path, origin)`: the latter is unsafe when `path` is
    // protocol-relative (e.g. `//evil-host/x`, reachable via a request URL like
    // `https://good.com//evil-host/x`). WHATWG URL would then treat the path's
    // leading host as the authority and discard the good origin, so a *relative*
    // Location would resolve against the attacker-controlled host — an SSRF /
    // request-misrouting pivot. See buildURL in ../utils.js.
    const base = this.#opts.origin && buildURL(this.#opts.origin, this.#opts.path)
    const { origin, pathname, search } = parseURL(new URL(this.#location, base))
    const path = search ? `${pathname}${search}` : pathname

    // Remove headers referring to the original URL.
    // By default it is Host only, unless it's a 303 (see below), which removes also all Content-* headers.
    // https://tools.ietf.org/html/rfc7231#section-6.4
    this.#opts = {
      ...this.#opts,
      headers: cleanRequestHeaders(
        this.#opts.headers,
        statusCode === 303,
        !isSameOrigin(this.#opts.origin, origin),
      ),
      path,
      origin,
      query: null,
    }

    // https://tools.ietf.org/html/rfc7231#section-6.4.4
    // In case of HTTP 303, always replace method to be either HEAD or GET
    if (statusCode === 303) {
      this.#opts = {
        ...this.#opts,
        method: this.#opts.method !== 'HEAD' ? 'GET' : 'HEAD',
        body: null,
      }
    }

    if (write !== null) {
      traceSafe(
        write,
        {
          id: this.#opts.id ?? null,
          // Post-rewrite method for the next hop (303 may have swapped it above).
          method: this.#opts.method ?? null,
          statusCode,
          from,
          to: traceUrl(this.#opts),
          // #count is 1-based: incremented above for this hop, so the first
          // followed redirect emits count 1.
          count: this.#count,
        },
        'undici:redirect',
      )
    }
  }

  onData(chunk) {
    if (this.#location) {
      /*
        https://tools.ietf.org/html/rfc7231#section-6.4

        TLDR: undici always ignores 3xx response bodies.

        Redirection is used to serve the requested resource from another URL, so it is assumes that
        no body is generated (and thus can be ignored). Even though generating a body is not prohibited.

        For status 301, 302, 303, 307 and 308 (the latter from RFC 7238), the specs mention that the body usually
        (which means it's optional and not mandated) contain just an hyperlink to the value of
        the Location response header, so the body can be ignored safely.

        For status 300, which is "Multiple Choices", the spec mentions both generating a Location
        response header AND a response body with the other possible location to follow.
        Since the spec explicitily chooses not to specify a format for such body and leave it to
        servers and browsers implementors, we ignore the body as there is no specified way to eventually parse it.
      */
    } else {
      return super.onData(chunk)
    }
  }

  onComplete(trailers) {
    if (this.#location) {
      /*
        https://tools.ietf.org/html/rfc7231#section-6.4

        TLDR: undici always ignores 3xx response trailers as they are not expected in case of redirections
        and neither are useful if present.

        See comment on onData method above for more detailed informations.
      */

      this.#location = null

      try {
        const result = this.#dispatch(this.#opts, this)
        if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
          // A composed dispatcher may return any thenable, not necessarily a
          // native Promise with `.catch()`. Promise assimilation also turns a
          // throwing `then` getter into a rejection without letting it escape
          // this callback. The follow-up return value is detached, so contain
          // downstream callback failures rather than creating a second
          // unhandled rejection.
          Promise.resolve(result).catch((err) => {
            try {
              this.onError(err)
            } catch {}
          })
        }
      } catch (err) {
        this.onError(err)
      }
    } else {
      super.onComplete(trailers)
    }
  }

  onError(error) {
    super.onError(error)
  }
}

// `target` is always a WHATWG-normalized origin (it comes off a parsed URL:
// lowercased host, default port elided, no path), while `optsOrigin` is
// caller-provided and may not be (trailing slash, explicit `:80`/`:443`,
// uppercase host — defaultLookup in index.js even produces `http://host:80`
// for object-form origins). A raw string compare misclassifies such
// same-origin redirects as cross-origin and strips authorization/cookie,
// breaking authenticated redirect flows with a confusing 401. Normalize
// through `URL.parse` before comparing; if optsOrigin is not parseable, the
// optional chain produces false, which fails toward stripping — the safe
// direction.
function isSameOrigin(optsOrigin, target) {
  if (optsOrigin === target) {
    return true
  }
  if (optsOrigin instanceof URL) {
    return optsOrigin.origin === target
  }
  return URL.parse(optsOrigin)?.origin === target
}

// https://tools.ietf.org/html/rfc7231#section-6.4.4
function shouldRemoveHeader(header, removeContent, unknownOrigin) {
  return (
    (header.length === 4 && header.toString().toLowerCase() === 'host') ||
    (removeContent && header.toString().toLowerCase().indexOf('content-') === 0) ||
    (unknownOrigin &&
      header.length === 13 &&
      header.toString().toLowerCase() === 'authorization') ||
    (unknownOrigin &&
      header.length === 19 &&
      header.toString().toLowerCase() === 'proxy-authorization') ||
    (unknownOrigin && header.length === 6 && header.toString().toLowerCase() === 'cookie')
  )
}

function setOwnHeader(headers, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(headers, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  } else {
    headers[key] = value
  }
}

// https://tools.ietf.org/html/rfc7231#section-6.4
function cleanRequestHeaders(headers, removeContent, unknownOrigin) {
  const ret = {}
  if (Array.isArray(headers)) {
    // undici accepts request headers as a flat [name, value, ...] array.
    // Object.keys on that yields numeric indices, not field names, so the
    // strip checks below would never match and the headers would be mangled
    // into { '0': name, '1': value, ... }. Normalize to an object first.
    headers = parseHeaders(headers)
  }
  if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (!shouldRemoveHeader(key, removeContent, unknownOrigin)) {
        // `__proto__` is a valid header token. Assigning it onto `{}` invokes
        // Object.prototype's legacy setter, which either drops a scalar value
        // or replaces the accumulator prototype with an array value.
        setOwnHeader(ret, key, headers[key])
      }
    }
  } else {
    assert(headers == null, 'headers must be an object or an array')
  }
  return ret
}

export default () => (dispatch) => (opts, handler) =>
  opts.follow ? dispatch(opts, new Handler(opts, { handler, dispatch })) : dispatch(opts, handler)
