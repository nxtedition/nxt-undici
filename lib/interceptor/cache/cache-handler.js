// The write path: a DecoratorHandler that watches a pass-through response,
// applies the RFC 9111 storability gates at header time and persists the
// buffered entry at onComplete. Emits one `undici:cache-store` doc per
// response — stored or skipped, with the failed gate as the reason.
import { DecoratorHandler, parseCacheControl, parseContentRange } from '../../utils.js'
import { isHopByHop } from '../proxy.js'
import { traceSafe, traceErr } from '../../trace.js'
import {
  DEFAULT_MAX_ENTRY_TTL,
  computeEntryTimes,
  determineAge,
  determineLifetime,
} from './freshness.js'
import { isEtagUsable, parseVary } from './headers.js'

const DEFAULT_MAX_ENTRY_SIZE = 128 * 1024

export class CacheHandler extends DecoratorHandler {
  #key
  #value
  #store
  #logger
  #maxEntrySize
  #maxEntryTTL
  #heuristic
  #defaultTTL
  #write
  #id
  #url

  constructor(
    key,
    { store, logger, handler, maxEntrySize, maxEntryTTL, heuristic, defaultTTL, write, id, url },
  ) {
    super(handler)

    this.#key = key
    this.#logger = logger
    this.#value = null
    this.#store = store
    this.#maxEntrySize = maxEntrySize ?? store.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE
    this.#maxEntryTTL = maxEntryTTL ?? store.maxEntryTTL ?? DEFAULT_MAX_ENTRY_TTL
    this.#heuristic = heuristic ?? false
    this.#defaultTTL = defaultTTL ?? null
    this.#write = write ?? null
    this.#id = id ?? null
    this.#url = url ?? null
  }

  // The single `undici:cache-store` emitter. `err` is the raw error (or null);
  // tagging is deferred here so no string work happens unless tracing is on.
  #trace(statusCode, stored, reason, sizeBytes, ttlSec, err) {
    if (this.#write !== null) {
      traceSafe(
        this.#write,
        {
          id: this.#id,
          method: this.#key.method ?? null,
          url: this.#url,
          statusCode,
          stored,
          reason,
          sizeBytes,
          ttlSec,
          err: err != null ? traceErr(err) : null,
        },
        'undici:cache-store',
      )
    }
  }

  // Storability declined at header time: emit the skip doc and pass the
  // response through untouched. `reason` names the failed gate and must stay
  // low-cardinality.
  #skip(reason, statusCode, headers, resume) {
    this.#trace(statusCode, false, reason, null, null, null)
    return super.onHeaders(statusCode, headers, resume)
  }

  onConnect(abort) {
    this.#value = null

    super.onConnect((reason) => {
      // TODO (fix): Cache partial results?
      abort(reason)
    })
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode < 200) {
      // Interim 1xx (e.g. 103 Early Hints) is not the final response — pass it
      // through with no store doc; the final response emits its own.
      return super.onHeaders(statusCode, headers, resume)
    }

    if (statusCode !== 307 && statusCode !== 200 && statusCode !== 206) {
      // A non-cacheable FINAL status (404, 500, ...): emit the skip doc so the
      // reason a response wasn't cached is visible, like every other gate.
      return this.#skip('status', statusCode, headers, resume)
    }

    // 'trailer' is the RFC 9110 field name; 'trailers' is kept for backwards
    // compatibility with servers that misspell it.
    if (headers.vary === '*' || headers.trailer || headers.trailers) {
      // Not cacheable...
      return this.#skip(headers.vary === '*' ? 'vary-star' : 'trailer', statusCode, headers, resume)
    }

    if (headers['set-cookie']) {
      // Shared cache: replaying Set-Cookie to other clients leaks sessions.
      return this.#skip('set-cookie', statusCode, headers, resume)
    }

    let contentRange
    if (headers['content-range']) {
      contentRange = parseContentRange(headers['content-range'])
      if (
        contentRange == null ||
        (contentRange.end != null &&
          (contentRange.end <= contentRange.start ||
            (contentRange.size != null && contentRange.end > contentRange.size)))
      ) {
        // We don't support caching responses with invalid content-range...
        return this.#skip('content-range', statusCode, headers, resume)
      }
      if (this.#key.method === 'HEAD') {
        // A HEAD response delivers no body, so we never receive the byte
        // window Content-Range describes — storing it would fail the store's
        // body-length validation.
        return this.#skip('head-range', statusCode, headers, resume)
      }
    }

    let contentLength
    if (headers['content-length']) {
      contentLength = Number(headers['content-length'])
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        // We don't support caching responses with invalid content-length...
        return this.#skip('content-length', statusCode, headers, resume)
      }
    }

    if (statusCode === 206 && !contentRange) {
      // We don't support caching range responses without content-range...
      return this.#skip('206-no-range', statusCode, headers, resume)
    }

    const cacheControlDirectives = parseCacheControl(headers['cache-control']) ?? {}

    // RFC 9111 §3.5: a shared cache may store a response to a request with
    // Authorization only when the response explicitly allows it: public,
    // s-maxage, or must-revalidate (safe because such entries are never
    // served stale without successful revalidation). Must stay in lockstep
    // with the serve-side gate in the interceptor (index.js). A duplicated
    // (array) authorization header is refused outright.
    const authorization = this.#key.headers.authorization
    if (authorization != null) {
      if (
        typeof authorization !== 'string' ||
        !(
          cacheControlDirectives.public === true ||
          cacheControlDirectives['s-maxage'] != null ||
          cacheControlDirectives['must-revalidate'] === true
        )
      ) {
        return this.#skip('auth', statusCode, headers, resume)
      }
    }

    // Unqualified private forbids shared-cache storage entirely; the
    // qualified form (private="field") only forbids storing the listed
    // fields, which are stripped below (RFC 9111 §5.2.2.7).
    if (cacheControlDirectives['no-store'] || cacheControlDirectives.private === true) {
      return this.#skip('no-store', statusCode, headers, resume)
    }

    if (cacheControlDirectives['must-understand']) {
      // Do nothing. We only cache responses that we understand...
    }

    if (cacheControlDirectives['no-transform']) {
      // Do nothing. We don't transform responses...
    }

    // must-revalidate / proxy-revalidate / unqualified no-cache /
    // stale-while-revalidate / stale-if-error responses ARE stored: the
    // directives constrain how the entry may be reused (validate first, never
    // serve stale, ...), which the read path enforces from the persisted
    // cacheControlDirectives.

    // parseVary returns null when the response can't be cached on Vary grounds:
    // a genuinely invalid Vary shape (a non-string, or an array with a
    // non-string entry), OR a member '*' inside a list (e.g. `Vary: Accept, *`).
    // Multiple Vary field lines arrive as a string array and ARE cached
    // (comma-joined). The gate above only catches the bare `Vary: *`, so a list
    // containing '*' reaches — and is rejected by — parseVary here.
    const vary = parseVary(headers.vary, this.#key.headers)
    if (vary == null) {
      return this.#skip('vary-invalid', statusCode, headers, resume)
    }

    const now = Date.now()

    let lifetimeInfo = determineLifetime(
      statusCode,
      headers,
      cacheControlDirectives,
      { heuristic: this.#heuristic, defaultTTL: this.#defaultTTL },
      now,
    )
    if (lifetimeInfo == null && cacheControlDirectives['no-cache'] === true) {
      // Store-and-revalidate (undici PR #5515): no expiration information at
      // all, but unqualified no-cache plus a validator means every reuse can
      // cost a 304 instead of a full 200.
      lifetimeInfo = { lifetime: 0, explicit: true }
    }
    if (lifetimeInfo == null) {
      return this.#skip('no-lifetime', statusCode, headers, resume)
    }

    const etag = typeof headers.etag === 'string' && isEtagUsable(headers.etag) ? headers.etag : ''
    const hasValidator = etag !== '' || typeof headers['last-modified'] === 'string'
    const age = determineAge(headers, now)
    const times = computeEntryTimes(
      lifetimeInfo.lifetime,
      lifetimeInfo.explicit,
      age,
      cacheControlDirectives,
      this.#maxEntryTTL,
      hasValidator,
      now,
    )
    if (times == null) {
      return this.#skip('stale', statusCode, headers, resume)
    }

    const start = contentRange ? contentRange.start : 0
    // HEAD never delivers a body, so a Content-Length must not drive the
    // stored byte window (end). Storing end = contentLength with an empty body
    // would fail the store's body-length validation and emit error-level log
    // spam on every cacheable HEAD response.
    const end = contentRange ? contentRange.end : this.#key.method === 'HEAD' ? 0 : contentLength

    if (end == null || end - start <= this.#maxEntrySize) {
      // Snapshot the headers: the same object is delivered downstream to the
      // caller (request() resolves with it before the body finishes), and the
      // entry isn't serialized to the store until onComplete. Without a copy,
      // any mutation the caller makes to res.headers while the body streams
      // would be persisted into the shared cache and replayed to every later
      // request. parseHeaders values are strings or string arrays, so a
      // one-level copy with array values sliced is a full snapshot. Use
      // Object.keys so only own enumerable header fields are copied — never
      // inherited properties from the prototype chain. Null prototype: on a
      // plain `{}` a header literally named `__proto__` would hit the
      // Object.prototype setter instead of becoming a data property (silent
      // drop / prototype-pollution vector).
      //
      // Stripped while copying (RFC 9111 §3.1): hop-by-hop fields, fields
      // listed in the Connection header, fields named by qualified
      // no-cache=/private= directives (§5.2.2.4/§5.2.2.7), and Age — cachedAt
      // is backdated by the corrected initial age, so the served Age is fully
      // recomputed and a stored Age would double-count.
      const excludedHeaders = new Set(['age'])
      const connection = headers.connection
      if (typeof connection === 'string') {
        for (const name of connection.split(',')) {
          excludedHeaders.add(name.trim().toLowerCase())
        }
      } else if (Array.isArray(connection)) {
        for (const line of connection) {
          for (const name of `${line}`.split(',')) {
            excludedHeaders.add(name.trim().toLowerCase())
          }
        }
      }
      if (Array.isArray(cacheControlDirectives['no-cache'])) {
        for (const name of cacheControlDirectives['no-cache']) {
          excludedHeaders.add(name)
        }
      }
      if (Array.isArray(cacheControlDirectives.private)) {
        for (const name of cacheControlDirectives.private) {
          excludedHeaders.add(name)
        }
      }

      const storedHeaders = Object.create(null)
      for (const name of Object.keys(headers)) {
        if (isHopByHop(name) || excludedHeaders.has(name.toLowerCase())) {
          continue
        }
        const val = headers[name]
        storedHeaders[name] = Array.isArray(val) ? val.slice() : val
      }

      this.#value = {
        body: [],
        start,
        end,
        cachedAt: times.cachedAt,
        staleAt: times.staleAt,
        deleteAt: times.deleteAt,
        statusCode,
        statusMessage: '',
        headers: storedHeaders,
        cacheControlDirectives,
        etag,
        vary,
        // Handler state.
        size: 0,
      }
      return super.onHeaders(statusCode, headers, resume)
    }

    // Known too-large at header time (Content-Length exceeds maxEntrySize): the
    // body is never buffered, so emit the skip doc now.
    return this.#skip('too-large', statusCode, headers, resume)
  }

  onData(chunk) {
    if (this.#value) {
      this.#value.size += chunk.length
      this.#value.body.push(chunk)

      if (this.#value.size > this.#maxEntrySize) {
        // The buffer flips to discarded exactly once per attempt (#value stays
        // null afterwards), so this is the single skip emission for it.
        const statusCode = this.#value.statusCode
        this.#value = null
        this.#trace(statusCode, false, 'too-large', null, null, null)
      }
    }

    return super.onData(chunk)
  }

  onComplete(trailers) {
    if (this.#value && (!trailers || Object.keys(trailers).length === 0)) {
      this.#value.end ??= this.#value.start + this.#value.size
      let storeErr = null
      try {
        this.#store.set(this.#key, this.#value)
      } catch (err) {
        storeErr = err
        if (err.message === 'database is locked') {
          // Database is busy. We don't bother trying again...
          this.#logger?.debug({ err }, 'failed to set cache entry')
        } else {
          this.#logger?.error({ err }, 'failed to set cache entry')
        }
      }
      // `stored` reflects what actually happened: a throwing set() (e.g.
      // 'database is locked') persisted nothing. `reason` stays null — this is
      // a store failure, not a storability gate; `err` carries the why.
      this.#trace(
        this.#value.statusCode,
        storeErr == null,
        null,
        this.#value.size,
        Math.round((this.#value.staleAt - this.#value.cachedAt) / 1000),
        storeErr,
      )
      this.#value = null
    } else if (this.#value) {
      // Unexpected trailers decline storability late — still one doc per
      // response, at the outcome.
      this.#trace(this.#value.statusCode, false, 'trailer', null, null, null)
      this.#value = null
    }

    super.onComplete(trailers)
  }
}
