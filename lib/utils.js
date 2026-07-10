import stream from 'node:stream'
import assert from 'node:assert'
import { util } from '@nxtedition/undici'
import createHttpError from 'http-errors'

let fastNow = Date.now()

setInterval(() => {
  fastNow = Date.now()
}, 1e3).unref()

export function getFastNow() {
  return fastNow
}

// Split a comma-list without treating commas inside quoted-string values as
// list delimiters. Cache-Control extensions are allowed to carry arbitrary
// quoted-string arguments, so a plain String#split(',') can promote text from
// an unknown extension value into a live directive (for example,
// `example="x, max-age=3600"`). quoted-pair escapes keep the following byte
// inside the quoted string, including an escaped quote.
function splitCacheControlLine(line) {
  const directives = []
  let start = 0
  let quoted = false
  let escaped = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (escaped) {
      escaped = false
    } else if (quoted && char === '\\') {
      escaped = true
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      directives.push(line.slice(start, i))
      start = i + 1
    }
  }

  directives.push(line.slice(start))
  return directives
}

/**
 * A quoted-string directive argument may itself contain commas that the
 * top-level comma split cut into separate fragments (`immutable="x, public"`).
 * When `value` opens a double-quote that its own fragment does not close,
 * advance past the continuation fragments (to the one carrying the closing
 * quote, or to the end for an unterminated quote) so a fragment like `public`
 * is not mis-parsed as its own directive. Returns the new loop index.
 * The qualified private/no-cache parser has its own richer version because it
 * must also reassemble the field-name list; this one only needs to skip.
 */
function endsWithUnescapedQuote(value) {
  if (value[value.length - 1] !== '"') {
    return false
  }

  // A quote preceded by an odd run of backslashes is part of quoted-pair,
  // not the quoted-string terminator. With an even run, the final backslash
  // is itself escaped and the quote remains unescaped.
  let backslashes = 0
  for (let i = value.length - 2; i >= 0 && value[i] === '\\'; i--) {
    backslashes++
  }
  return backslashes % 2 === 0
}

function skipQuotedArgument(directives, i, value) {
  const trimmed = value.trim()
  if (trimmed[0] !== '"' || (trimmed.length > 1 && endsWithUnescapedQuote(trimmed))) {
    return i
  }
  for (let j = i + 1; j < directives.length; j++) {
    i = j
    const part = directives[j].trim()
    if (endsWithUnescapedQuote(part)) {
      break
    }
  }
  return i
}

/**
 * Vendored from undici's parseCacheControlHeader (lib/util/cache.js) with two
 * deliberate deviations, both toward the conservative reading of RFC 9111:
 * - duplicated max-age keeps the SMALLER value (§4.2.1 says a cache is free to
 *   pick, so pick the one that revalidates sooner), upstream keeps the larger;
 * - a bare (valueless) max-stale is represented as Infinity per §5.2.1.2
 *   ("willing to accept a stale response of any age"), upstream drops it.
 *
 * Qualified no-cache/private (e.g. `no-cache="set-cookie"`) parse to an array
 * of the listed field names; the unqualified forms parse to `true`. Callers
 * that mean "unqualified" must check `=== true`, not truthiness.
 * Malformed s-maxage / valued revalidation directives use `false` as a
 * restrictive sentinel: freshness code treats them as stale/prohibitive,
 * while permission checks can distinguish them from syntactically valid
 * directives that allow shared caching of authenticated responses.
 *
 * Keeps the historical wrapper contract: '', [], and non-strings return null
 * (call sites rely on `?? {}`); an array of field lines is accepted directly
 * (Cache-Control is list-typed, duplicated lines are legal per RFC 9110 §5.2).
 *
 * @param {string | string[] | null | undefined} header
 * @returns {Record<string, boolean | number | string[]> | null}
 */
export function parseCacheControl(header) {
  let directives
  if (Array.isArray(header)) {
    directives = []
    for (const line of header) {
      if (typeof line !== 'string') {
        return null
      }
      directives.push(...splitCacheControlLine(line))
    }
    if (directives.length === 0) {
      return null
    }
  } else if (header && typeof header === 'string') {
    directives = splitCacheControlLine(header)
  } else {
    return null
  }

  const output = {}

  for (let i = 0; i < directives.length; i++) {
    const directive = directives[i].toLowerCase()
    const keyValueDelimiter = directive.indexOf('=')

    let key
    let value
    if (keyValueDelimiter !== -1) {
      key = directive.substring(0, keyValueDelimiter).trim()
      value = directive.substring(keyValueDelimiter + 1)
    } else {
      key = directive.trim()
    }

    switch (key) {
      case 'min-fresh':
      case 'max-stale':
      case 'max-age':
      case 's-maxage':
      case 'stale-while-revalidate':
      case 'stale-if-error': {
        if (value === undefined) {
          if (key === 'max-stale') {
            // Bare max-stale: any staleness is acceptable (RFC 9111
            // §5.2.1.2). Number semantics keep call-site math
            // (`staleAt + max-stale * 1000`) working unchanged. ??= so a
            // bare duplicate never widens an existing bounded max-stale
            // (the conservative duplicate rule below).
            output[key] ??= Infinity
          }
          continue
        }

        // RFC 9110 §5.6.3: a recipient may remove BWS/OWS around the value, so
        // tolerate whitespace (`max-age= 60`, `max-age=60 `) rather than
        // dropping the directive.
        value = value.trim()

        if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
          value = value.substring(1, value.length - 1)
        }

        // RFC 9111 delta-seconds are 1*DIGIT: a malformed value
        // (`max-age=60junk`, `-1`, `1.5`) must never be parseInt-coerced into
        // freshness math. A malformed max-age surfaces as 0 (already
        // expired); malformed s-maxage uses a false sentinel that freshness
        // code also normalizes to 0. Keeping those directives present avoids
        // falling through to Expires/heuristics, while the sentinel keeps an
        // invalid s-maxage from granting shared caching under Authorization.
        // Stale-window and request directives are dropped: absence is already
        // the conservative reading there.
        let parsedValue
        if (/^\d+$/.test(value)) {
          parsedValue = parseInt(value, 10)
        } else if (key === 'max-age') {
          parsedValue = 0
        } else if (key === 's-maxage') {
          parsedValue = false
        } else {
          continue
        }

        if (key in output) {
          // Duplicated directive: keep the conservative value (§4.2.1 lets a
          // cache pick one or consider the response stale). For the
          // freshness/stale-window grants and max-stale that is the smaller
          // value; for min-fresh — a demand for MORE remaining freshness —
          // it is the larger.
          if (output[key] === false || parsedValue === false) {
            // Keep invalid s-maxage distinguishable from a valid s-maxage=0:
            // only the latter grants shared caching under Authorization.
            output[key] = false
          } else {
            output[key] =
              key === 'min-fresh'
                ? Math.max(output[key], parsedValue)
                : Math.min(output[key], parsedValue)
          }
        } else {
          output[key] = parsedValue
        }

        break
      }
      case 'private':
      case 'no-cache': {
        if (value) {
          // Qualified form: a quoted, possibly comma-separated list of field
          // names (`no-cache="set-cookie, warning"`).
          // https://www.rfc-editor.org/rfc/rfc9111.html#name-no-cache-2
          //
          // The unqualified form is strictly more restrictive (forbids
          // storing / demands validation for the WHOLE response), so when
          // both forms appear (`private, private="x"` — invalid but seen in
          // the wild), the qualified form must never clobber the `true`.
          value = value.trim()
          if (value[0] === '"') {
            const headerNames = [value.substring(1)]

            // length > 1: a lone `"` is an opening quote, not a closed list.
            // The quote-aware splitter normally keeps the complete value in
            // one part. Retain the scan for malformed/legacy input so any
            // unterminated value still fails restrictive.
            let foundEndingQuote = value.length > 1 && value[value.length - 1] === '"'
            if (!foundEndingQuote) {
              for (let j = i + 1; j < directives.length; j++) {
                // Trim before the closing-quote check: optional whitespace
                // between the quote and the next comma (`no-cache="a, b" ,x`)
                // must not defeat the scan.
                const nextPart = directives[j].trim()
                headerNames.push(nextPart)
                if (nextPart.length !== 0 && nextPart[nextPart.length - 1] === '"') {
                  foundEndingQuote = true
                  // Consume the scanned parts so a quoted fragment (e.g. a
                  // literal `max-age=1` inside the field list) is not
                  // re-parsed as a real directive.
                  i = j
                  break
                }
              }
            }

            if (foundEndingQuote) {
              const lastHeader = headerNames[headerNames.length - 1]
              if (lastHeader[lastHeader.length - 1] === '"') {
                headerNames[headerNames.length - 1] = lastHeader.substring(0, lastHeader.length - 1)
              }
              if (output[key] !== true) {
                // Drop empty members (split/trim artifacts of `"a,"` etc.).
                // A quoted list with NO real field names (`private=""`,
                // `private=","`) is malformed — the ABNF requires
                // 1#field-name — and must fail RESTRICTIVE as the
                // unqualified directive, like every other malformed form of
                // private/no-cache; an empty field list would fail OPEN
                // (qualified private stores the response and strips nothing).
                const fields = headerNames
                  .flatMap((name) => name.split(','))
                  .map((name) => name.trim().toLowerCase())
                  .filter((name) => name !== '')
                if (fields.length === 0) {
                  output[key] = true
                } else {
                  output[key] = Array.isArray(output[key]) ? output[key].concat(fields) : fields
                }
              }
            } else {
              // Unterminated quoted list (invalid header). Fail restrictive:
              // treat as the unqualified form, and consume the remaining
              // parts — they are fragments of the broken quoted string, not
              // real directives.
              output[key] = true
              i = directives.length
            }
          } else {
            // Unquoted value (e.g. `private=set-cookie`): the qualified form
            // MUST be a quoted field-list (RFC 9111 §5.2.2.7). A bare token is
            // malformed — fail restrictive and treat it as the unqualified
            // directive (forbid storing / demand revalidation for the whole
            // response) rather than a more permissive field list.
            output[key] = true
          }

          break
        }
      }
      // eslint-disable-next-line no-fallthrough
      case 'no-store':
        // no-store (plus the private/no-cache empty-value fallthrough above):
        // a malformed valued form (`no-store="x"`, `no-store=`) fails
        // RESTRICTIVE and is treated as the bare directive — dropping it would
        // fail OPEN, storing/serving a response the origin forbade. A
        // comma-spanning quoted argument is consumed so its tail can't leak.
        if (value !== undefined) {
          i = skipQuotedArgument(directives, i, value)
        }
        output[key] = true
        break
      case 'must-revalidate':
      case 'proxy-revalidate': {
        // A malformed valued form still prohibits stale reuse, but it must
        // remain distinguishable from the valid bare must-revalidate form:
        // only the latter grants shared storage/reuse under Authorization
        // (RFC 9111 §3.5). A valid duplicate dominates an invalid one. A
        // comma-spanning quoted argument is still consumed so its tail can't
        // leak as a directive.
        if (value === undefined) {
          output[key] = true
        } else {
          i = skipQuotedArgument(directives, i, value)
          if (output[key] !== true) {
            output[key] = false
          }
        }
        break
      }
      case 'immutable':
        // RFC 8246 §2: immutable takes no arguments, but if one is present it
        // has no meaning and MUST be ignored. Ignore the argument, not the
        // directive itself — and consume a comma-spanning quoted argument
        // (`immutable="x, public"`) so its tail isn't parsed as a directive.
        if (value !== undefined) {
          i = skipQuotedArgument(directives, i, value)
        }
        output[key] = true
        break
      case 'public':
      case 'no-transform':
      case 'must-understand':
      case 'only-if-cached':
        // Permission-GRANTING valueless directives: an explicit `=` (even
        // empty, e.g. `public=`) is an invalid qualified form and is ignored
        // — NOT treated as the bare directive. Ignoring is the restrictive
        // direction for grants; the safety-critical group above is the
        // opposite. `value === undefined` is the genuine valueless form.
        if (value !== undefined) {
          // Still consume a comma-spanning quoted argument before ignoring, so
          // its tail (`public="x, no-store`) can't leak as a directive.
          i = skipQuotedArgument(directives, i, value)
          continue
        }

        output[key] = true
        break
      default:
        // Unknown directives are ignored per RFC 9111 §5.2.3.
        continue
    }
  }

  return output
}

const HTTP_DATE_MONTHS = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
}

// IMF-fixdate:  Sun, 06 Nov 1994 08:49:37 GMT
const IMF_DATE_RE =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i
// obsolete RFC 850: Sunday, 06-Nov-94 08:49:37 GMT
const RFC850_DATE_RE =
  /^(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/i
// ANSI C asctime(): Sun Nov  6 08:49:37 1994 (day space-padded)
const ASCTIME_DATE_RE =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i

/**
 * HTTP-date parser per RFC 9110 §5.6.7 (the three accepted formats only).
 * Deliberately NOT `new Date(str)`: V8 accepts many non-HTTP formats, and
 * RFC 9111 §5.3 requires an invalid Expires (notably `Expires: 0`) to be
 * treated as already expired rather than silently ignored — which needs the
 * parse failure to be observable.
 *
 * Recipient leniency (deliberate divergence from upstream undici's parser):
 * token case is ignored and a weekday name that mismatches the actual date is
 * NOT grounds for rejection — the numeric fields alone determine the moment,
 * and origins with buggy date formatting exist in the wild (conformance
 * freshness-expires-ansi-c / wrong-case-* shapes). A future Expires from such
 * an origin would otherwise be inverted into "already expired". Structurally
 * invalid dates (Feb 30) are still rejected via the day-of-month
 * normalization check.
 *
 * @param {string} date
 * @param {number} [now] Reference time in epoch milliseconds (as from
 *   `Date.now()`), used ONLY to place RFC 850 two-digit years in the rolling
 *   50-year window. Resolved lazily — `Date.now()` is called only when an
 *   RFC 850 date is actually parsed, and a non-finite value falls back to it.
 * @returns {Date | undefined} undefined when not a valid HTTP-date
 */
export function parseHttpDate(date, now) {
  if (typeof date !== 'string') {
    return undefined
  }

  let day
  let month
  let year
  let hour
  let minute
  let second
  let hasTwoDigitYear = false
  // Reference clock for RFC 850 two-digit-year windowing, resolved lazily (and
  // guarded against a non-finite `now`) only if that branch is actually taken.
  let nowMs = 0

  let m = IMF_DATE_RE.exec(date)
  if (m) {
    day = Number(m[1])
    month = HTTP_DATE_MONTHS[m[2].toUpperCase()]
    year = Number(m[3])
    hour = Number(m[4])
    minute = Number(m[5])
    second = Number(m[6])
  } else if ((m = RFC850_DATE_RE.exec(date))) {
    day = Number(m[1])
    month = HTTP_DATE_MONTHS[m[2].toUpperCase()]
    // RFC 9110 §5.6.7 uses a moving window, not the cookie date parser's
    // fixed 1970/2069 split: start in the current century, then map a year
    // more than 50 years in the future to the most recent past century.
    nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    const currentYear = new Date(nowMs).getUTCFullYear()
    year = Math.floor(currentYear / 100) * 100 + Number(m[3])
    hasTwoDigitYear = true
    hour = Number(m[4])
    minute = Number(m[5])
    second = Number(m[6])
  } else if ((m = ASCTIME_DATE_RE.exec(date))) {
    month = HTTP_DATE_MONTHS[m[1].toUpperCase()]
    day = Number(m[2].trim())
    hour = Number(m[3])
    minute = Number(m[4])
    second = Number(m[5])
    year = Number(m[6])
  } else {
    return undefined
  }

  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined
  }

  if (hasTwoDigitYear) {
    const futureLimit = new Date(nowMs)
    futureLimit.setUTCFullYear(futureLimit.getUTCFullYear() + 50)
    if (Date.UTC(year, month, day, hour, minute, second) > futureLimit.getTime()) {
      year -= 100
    }
  }

  const result = new Date(Date.UTC(year, month, day, hour, minute, second))
  // Date.UTC normalizes out-of-range components (Feb 30 → Mar 2); a
  // normalized day-of-month means the named date never existed — reject.
  return result.getUTCDate() === day ? result : undefined
}

export function isDisturbed(body) {
  if (
    body == null ||
    typeof body === 'string' ||
    Buffer.isBuffer(body) ||
    typeof body === 'function'
  ) {
    return false
  }

  if (body.readableDidRead === false) {
    return false
  }

  return stream.isDisturbed(body)
}

/**
 * @typedef {object} RangeHeader
 * @property {number} start
 * @property {number | null} end
 * @property {number | null} size
 */

/**
 * @param {string} [range]
 * @returns {RangeHeader|null|undefined}
 */
export function parseContentRange(range) {
  if (range == null || range === '') {
    return undefined
  }

  if (typeof range !== 'string') {
    return null
  }

  const m = range.match(/^bytes (\d+)-(\d+)?\/(\d+|\*)$/)
  return m
    ? {
        start: parseInt(m[1], 10),
        end: m[2] ? parseInt(m[2], 10) + 1 : null,
        size: m[3] === '*' ? null : parseInt(m[3], 10),
      }
    : null
}

// Parsed accordingly to RFC 9110
// https://www.rfc-editor.org/rfc/rfc9110#field.range
/**
 * @param {string} [range]
 * @returns {RangeHeader|null|undefined}
 */
export function parseRangeHeader(range) {
  if (range == null || range === '') {
    return undefined
  }

  if (typeof range !== 'string') {
    return null
  }

  const m = range.match(/^bytes=(\d+)-(\d+)?$/)
  return m
    ? {
        start: parseInt(m[1], 10),
        end: m[2] ? parseInt(m[2], 10) + 1 : null,
        size: null,
      }
    : null
}

export function parseURL(url) {
  if (typeof url === 'string') {
    url = new URL(url)

    if (!/^https?:/.test(url.origin || url.protocol)) {
      throw new Error('Invalid URL protocol: the URL must start with `http:` or `https:`.')
    }

    return url
  }

  if (!url || typeof url !== 'object') {
    throw new Error('Invalid URL: The URL argument must be a non-null object.')
  }

  if (url.port != null && url.port !== '' && !Number.isFinite(parseInt(url.port))) {
    throw new Error(
      'Invalid URL: port must be a valid integer or a string representation of an integer.',
    )
  }

  if (url.path != null && typeof url.path !== 'string') {
    throw new Error('Invalid URL path: the path must be a string or null/undefined.')
  }

  if (url.pathname != null && typeof url.pathname !== 'string') {
    throw new Error('Invalid URL pathname: the pathname must be a string or null/undefined.')
  }

  if (url.hostname != null && typeof url.hostname !== 'string') {
    throw new Error('Invalid URL hostname: the hostname must be a string or null/undefined.')
  }

  if (url.origin != null && typeof url.origin !== 'string') {
    throw new Error('Invalid URL origin: the origin must be a string or null/undefined.')
  }

  if (!/^https?:/.test(url.origin || url.protocol)) {
    throw new Error('Invalid URL protocol: the URL must start with `http:` or `https:`.')
  }

  if (!(url instanceof URL)) {
    const port = url.port != null ? url.port : url.protocol === 'https:' ? 443 : 80
    const origin = url.origin != null ? url.origin : `${url.protocol}//${url.hostname}:${port}`
    const path = url.path != null ? url.path : `${url.pathname || ''}${url.search || ''}`

    url = buildURL(origin, path)
  }

  return url
}

// Build an absolute URL from an origin and a path by concatenation.
//
// `new URL(path, origin)` is unsafe when `path` is itself absolute or
// protocol-relative (e.g. starts with `//host`): per the WHATWG URL spec, a
// protocol-relative first argument inherits only the scheme from the base and
// resolves its authority from `path`, so the origin's host is silently
// discarded. Concatenating `origin + path` and parsing the whole thing as a
// single absolute URL keeps the origin authoritative — which matters for
// redirect resolution, where a leaked host is an SSRF/misrouting vector.
//
// From https://developer.mozilla.org/en-US/docs/Web/API/URL/URL:
// If first parameter is a relative URL, second param is required, and will be used as the base URL.
// If first parameter is an absolute URL, a given second param will be ignored.
export function buildURL(origin, path) {
  origin = String(origin)
  path = path == null ? '' : String(path)

  if (origin.endsWith('/')) {
    origin = origin.substring(0, origin.length - 1)
  }

  if (path && !path.startsWith('/')) {
    path = `/${path}`
  }

  return new URL(origin + path)
}

export function parseOrigin(url) {
  url = parseURL(url)

  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('invalid url')
  }

  return url
}

export function isStream(obj) {
  return (
    obj && typeof obj === 'object' && typeof obj.pipe === 'function' && typeof obj.on === 'function'
  )
}

// based on https://github.com/node-fetch/fetch-blob/blob/8ab587d34080de94140b54f07168451e7d0b655e/index.js#L229-L241 (MIT License)
export function isBlobLike(object) {
  return (
    (Blob && object instanceof Blob) ||
    (object &&
      typeof object === 'object' &&
      (typeof object.stream === 'function' || typeof object.arrayBuffer === 'function') &&
      /^(Blob|File)$/.test(object[Symbol.toStringTag]))
  )
}

export function isBuffer(buffer) {
  // See, https://github.com/mcollina/undici/pull/319
  return buffer instanceof Uint8Array || Buffer.isBuffer(buffer)
}

export function bodyLength(body) {
  if (body == null) {
    return 0
  } else if (isStream(body)) {
    const state = body._readableState
    return state && state.ended === true && Number.isFinite(state.length) ? state.length : null
  } else if (isBlobLike(body)) {
    return body.size != null ? body.size : null
  } else if (isBuffer(body)) {
    return body.byteLength
  }

  return null
}

export class DecoratorHandler {
  #handler
  #aborted = false
  #errored = false
  #completed = false
  #abort

  constructor(handler) {
    if (typeof handler !== 'object' || handler === null) {
      throw new TypeError('handler must be an object')
    }
    this.#handler = handler
  }

  onConnect(abort) {
    this.#aborted = false
    this.#errored = false
    this.#completed = false
    this.#abort = abort

    return this.#handler.onConnect?.((reason) => {
      if (!this.#aborted && !this.#completed && !this.#errored) {
        this.#aborted = true
        this.#abort(reason)
      }
    })
  }

  onUpgrade(statusCode, headers, socket) {
    if (!this.#aborted && !this.#errored) {
      assert(!this.#completed)
      return this.#handler.onUpgrade?.(statusCode, headers, socket)
    }
  }

  onHeaders(statusCode, headers, resume) {
    if (!this.#aborted && !this.#errored) {
      assert(!this.#completed)
      return this.#handler.onHeaders?.(statusCode, headers, resume)
    }
  }

  onData(data) {
    if (!this.#aborted && !this.#errored && data != null) {
      assert(!this.#completed)
      return this.#handler.onData?.(data)
    }
  }

  onComplete(trailers) {
    if (!this.#aborted && !this.#completed && !this.#errored) {
      this.#completed = true
      return this.#handler.onComplete?.(trailers)
    }
  }

  onError(err) {
    if (!this.#errored && !this.#completed) {
      this.#errored = true
      return this.#handler.onError?.(err)
    }
  }
}

/**
 * @param {Record<string, string | string[] | null | undefined> | (Buffer | string | (Buffer | string)[])[]} headers
 * @param {Record<string, string | string[]>} [obj]
 * @returns {Record<string, string | string[]>}
 */
export function parseHeaders(headers, obj) {
  if (obj == null) {
    obj = {}
  } else {
    // TODO (fix): assert obj values type?
  }

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key2 = headers[i]
      const val2 = headers[i + 1]

      // TODO (fix): assert key2 type?
      // TODO (fix): assert val2 type?

      if (val2 == null) {
        continue
      }

      const key = util.headerNameToString(key2)
      let val = obj[key]

      // `key in obj`, not `if (val)`: an empty-string value ('') is a valid,
      // present header. A truthy check would treat it as absent and overwrite
      // it on a duplicate occurrence, silently dropping the first value.
      if (key in obj) {
        if (!Array.isArray(val)) {
          val = [val]
          obj[key] = val
        }

        if (Array.isArray(val2)) {
          val.push(...val2.filter((x) => x != null).map((x) => `${x}`))
        } else {
          val.push(`${val2}`)
        }
      } else {
        obj[key] = Array.isArray(val2)
          ? val2.filter((x) => x != null).map((x) => `${x}`)
          : `${val2}`
      }
    }
  } else if (typeof headers === 'object' && headers !== null) {
    for (const key2 of Object.keys(headers)) {
      const val2 = headers[key2]

      // TODO (fix): assert key2 type?
      // TODO (fix): assert val2 type?

      if (val2 == null) {
        continue
      }

      const key = util.headerNameToString(key2)
      let val = obj[key]

      // See the array branch above: presence check, not truthiness, so a
      // stored empty string is not clobbered by a later duplicate.
      if (key in obj) {
        if (!Array.isArray(val)) {
          val = [val]
          obj[key] = val
        }
        if (Array.isArray(val2)) {
          val.push(...val2.filter((x) => x != null).map((x) => `${x}`))
        } else {
          val.push(`${val2}`)
        }
      } else {
        obj[key] = Array.isArray(val2)
          ? val2.filter((x) => x != null).map((x) => `${x}`)
          : `${val2}`
      }
    }
  } else if (headers != null) {
    throw new Error('invalid argument: headers')
  }

  return obj
}

export function decorateError(err, opts, { statusCode, headers, trailers, body }) {
  try {
    if (err == null) {
      const stackTraceLimit = Error.stackTraceLimit
      Error.stackTraceLimit = 0
      try {
        err = createHttpError(statusCode)
      } finally {
        Error.stackTraceLimit = stackTraceLimit
      }
    }

    if (statusCode != null) {
      err.statusCode = statusCode
    }

    err.req = {
      path: opts.path,
      origin: opts.origin,
      method: opts?.method,
      headers: opts?.headers,
    }

    if (Array.isArray(body) && body.every((x) => Buffer.isBuffer(x))) {
      body = Buffer.concat(body).toString()
    } else if (typeof body !== 'string') {
      body = null
    }

    // A duplicated content-type response header arrives as an array (undici's
    // parseHeaders collapses repeats); coerce to the first value before
    // calling string methods, otherwise this throws and the catch below
    // discards all decoration into an opaque AggregateError.
    const contentType = Array.isArray(headers?.['content-type'])
      ? headers['content-type'][0]
      : headers?.['content-type']
    if (typeof body === 'string' && (!contentType || contentType.startsWith('application/json'))) {
      try {
        body = JSON.parse(body)
      } catch {
        // Do nothing...
      }
    }

    err.res = {
      headers,
      trailers,
      statusCode,
    }

    if (body) {
      err.body = body
      if (body.reason != null) {
        err.reason ??= body.reason
      }
      if (body.code != null) {
        err.code ??= body.code
      }
      if (body.error != null) {
        err.error ??= body.error
      }
    }

    return err
  } catch (er) {
    return new AggregateError([er, err])
  }
}
