// Header-level helpers shared by the read (index.js), write (cache-handler.js)
// and revalidation paths: Vary selector maps, conditional-request headers and
// ETag handling. Pure functions — no store or handler state.

/**
 * Builds the Vary selector map (RFC 9111 §4.1): for each field named in the
 * response Vary header, records the request's value (a null sentinel when the
 * header was absent — absent-vs-present is a mismatch, so an empty map must
 * NOT act as a wildcard). Selector names are lowercased and stored on a null
 * prototype: names come from the (server-controlled) Vary header, so a
 * `__proto__` entry on a plain `{}` would hit the Object.prototype setter and
 * be silently dropped.
 *
 * Returns null when the response is NOT cacheable on Vary grounds: a
 * non-string Vary (duplicated header lines) or a Vary containing '*' (which
 * never matches, RFC 9111 §4.1).
 *
 * @returns {Record<string, string | string[] | null> | null}
 */
export function parseVary(varyHeader, requestHeaders) {
  const vary = Object.create(null)
  if (varyHeader == null) {
    return vary
  }
  if (typeof varyHeader !== 'string') {
    return null
  }
  for (const name of varyHeader.split(',').map((key) => key.trim().toLowerCase())) {
    if (name === '*') {
      return null
    }
    if (name === '') {
      // Empty field-name (a bare/trailing comma, or `Vary:` with no value) is
      // not a selector — skip it so it can't become a spurious '' key.
      continue
    }
    vary[name] = requestHeaders[name] ?? null
  }
  return vary
}

/**
 * Conditional request headers for revalidating a stored entry (RFC 9111
 * §4.3.1). Per RFC 9110 §13.1.3 and undici PR #5512, If-Modified-Since echoes
 * the stored Last-Modified VERBATIM when available (nginx's default
 * `if_modified_since exact` requires a byte-identical value), falling back to
 * the response Date, then to the (backdated) receipt time.
 *
 * The stored vary values need no replay: the store only returns entries whose
 * selecting headers already match this request.
 */
export function conditionalHeaders(headers, entry) {
  // Null prototype, like every other header map the cache builds (see makeKey
  // in store.js): the request header names are caller-controlled, so a plain
  // `{}` would expose Object.prototype (a `__proto__`/`constructor`/`toString`
  // field name reading through the chain instead of as absent) once these
  // headers flow back down the dispatch chain. Object.keys copies own fields
  // only; values are request header strings/arrays, copied by reference (the
  // shallow copy the previous spread also made).
  const condHeaders = Object.create(null)
  for (const name of Object.keys(headers)) {
    condHeaders[name] = headers[name]
  }
  if (entry.etag) {
    condHeaders['if-none-match'] = entry.etag
  }
  const lastModified = entry.headers?.['last-modified']
  const date = entry.headers?.date
  condHeaders['if-modified-since'] =
    typeof lastModified === 'string'
      ? lastModified
      : typeof date === 'string'
        ? date
        : new Date(entry.cachedAt).toUTCString()
  return condHeaders
}

/**
 * RFC 9110 Section 8.8.3.2: Weak comparison — two etags match if their
 * opaque-tags match, ignoring the W/ prefix.
 *
 * @param {string} ifNoneMatch - The If-None-Match header value (may contain multiple etags)
 * @param {string} etag - The cached etag
 * @returns {boolean}
 */
export function weakMatch(ifNoneMatch, etag) {
  if (ifNoneMatch === '*') {
    return true
  }

  const normalize = (tag) => (tag.startsWith('W/') ? tag.slice(2) : tag)
  const cached = normalize(etag)

  for (const raw of ifNoneMatch.split(',')) {
    if (normalize(raw.trim()) === cached) {
      return true
    }
  }

  return false
}

/**
 * Note: this deviates from the spec a little. Empty etags ("", W/"") are valid,
 *  however, including them in cached resposnes serves little to no purpose.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9110.html#name-etag
 *
 * @param {string|any} etag
 * @returns {boolean}
 */
export function isEtagUsable(etag) {
  if (typeof etag !== 'string') {
    return false
  }

  if (etag.length <= 2) {
    // Shortest an etag can be is two chars (just ""). This is where we deviate
    //  from the spec requiring a min of 3 chars however
    return false
  }

  if (etag[0] === '"' && etag[etag.length - 1] === '"') {
    // ETag: ""asd123"" or ETag: "W/"asd123"", kinda undefined behavior in the
    //  spec. Some servers will accept these while others don't.
    // ETag: "asd123"
    return !(etag[1] === '"' || etag.startsWith('"W/'))
  }

  if (etag.startsWith('W/"') && etag[etag.length - 1] === '"') {
    // ETag: W/"", also where we deviate from the spec & require a min of 3
    //  chars
    // ETag: for W/"", W/"asd123"
    return etag.length !== 4
  }

  // Anything else
  return false
}
