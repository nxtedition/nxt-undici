// Header-level helpers shared by the read (index.js), write (cache-handler.js)
// and revalidation paths: Vary selector maps, conditional-request headers and
// ETag handling. Pure functions — no store or handler state.

const ENTITY_TAG_RE = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/

/**
 * Builds the Vary selector map (RFC 9111 §4.1): for each field named in the
 * response Vary header, records the request's value (a null sentinel when the
 * header was absent — absent-vs-present is a mismatch, so an empty map must
 * NOT act as a wildcard). Selector names are lowercased and stored on a null
 * prototype: names come from the (server-controlled) Vary header, so a
 * `__proto__` entry on a plain `{}` would hit the Object.prototype setter and
 * be silently dropped.
 *
 * Vary is a list-typed field (RFC 9110 §5.2), so an origin may emit it as
 * multiple field lines, which the undici header parser surfaces as a string
 * array. Those lines are comma-joined before parsing — the same treatment
 * parseCacheControl gives duplicated Cache-Control lines.
 *
 * Returns null when the response is NOT cacheable on Vary grounds: a Vary of a
 * genuinely invalid shape (a non-string, or an array with a non-string entry)
 * or a Vary containing '*' (which never matches, RFC 9111 §4.1).
 *
 * @param {string | string[] | null | undefined} varyHeader - the response Vary header
 * @param {Record<string, string | string[] | undefined>} requestHeaders - the request's headers, keyed by lowercased name
 * @returns {Record<string, string | string[] | null> | null}
 */
export function parseVary(varyHeader, requestHeaders) {
  const vary = Object.create(null)
  if (varyHeader == null) {
    return vary
  }
  let varyString
  if (typeof varyHeader === 'string') {
    varyString = varyHeader
  } else if (Array.isArray(varyHeader)) {
    for (const line of varyHeader) {
      if (typeof line !== 'string') {
        return null
      }
    }
    varyString = varyHeader.join(',')
  } else {
    return null
  }
  for (const name of varyString.split(',').map((key) => key.trim().toLowerCase())) {
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
 * Whether a response field is named by a qualified no-cache or private
 * directive. RFC 9111 §3.1 requires those fields to be excluded from storage
 * by all caches (no-cache) or shared caches (private). Field names are
 * case-insensitive (§5.2.2.4 / §5.2.2.7).
 */
export function isQualifiedFieldExcluded(cacheControlDirectives, fieldName) {
  const name = fieldName.toLowerCase()
  for (const directive of ['no-cache', 'private']) {
    const fields = cacheControlDirectives[directive]
    if (
      Array.isArray(fields) &&
      fields.some((field) => typeof field === 'string' && field.toLowerCase() === name)
    ) {
      return true
    }
  }
  return false
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
  // RFC 9110 §13.1.2: If-None-Match = "*" / #entity-tag. '*' is the alternative
  // to the entity-tag list, not a member of it, so only a lone '*' (after OWS
  // trimming) is a wildcard precondition. A list such as '*, *' or '*, "etag"'
  // — e.g. duplicated wildcard header lines collapsed per §5.3 — is malformed
  // and must NOT be promoted to a wildcard.
  if (ifNoneMatch.trim() === '*') {
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
 * Whether a field value is exactly one RFC 9110 §8.8.3 entity-tag.
 * opaque-tag is DQUOTE *etagc DQUOTE, so the empty strong and weak tags are
 * valid; space, DQUOTE, DEL and characters above obs-text are not valid etagc.
 *
 * @param {unknown} etag
 * @returns {boolean}
 */
export function isEtagUsable(etag) {
  return typeof etag === 'string' && ENTITY_TAG_RE.test(etag)
}
