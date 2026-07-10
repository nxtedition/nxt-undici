import { DecoratorHandler, buildURL } from '../../utils.js'
import { traceSafe, traceErr } from '../../trace.js'
import { ignoreStoreResult } from './store.js'

/**
 * RFC 9111 §4.4: a non-error response to an unsafe method invalidates the
 * stored entries for the target URI and any same-origin Location /
 * Content-Location URIs (undici PR #5514). Cross-origin targets are skipped —
 * honoring an attacker-influenced Location against another origin's entries
 * would be a cache-poisoning vector.
 */
export class InvalidationHandler extends DecoratorHandler {
  #key
  #store
  #logger
  #write
  #id
  #url

  constructor(key, { store, logger, handler, write, id, url }) {
    super(handler)
    this.#key = key
    this.#store = store
    this.#logger = logger
    this.#write = write ?? null
    this.#id = id ?? null
    this.#url = url ?? null
  }

  onHeaders(statusCode, headers, resume) {
    if (statusCode >= 200 && statusCode <= 399) {
      // Invalidation failures must never break the actual response. Deletes
      // are idempotent, so a retry re-driving onHeaders is harmless.
      let paths = 0
      let invalidateErr = null
      try {
        paths = this.#invalidate(headers)
      } catch (err) {
        invalidateErr = err
        if (err.message === 'database is locked') {
          this.#logger?.debug({ err }, 'failed to invalidate cache entry')
        } else {
          this.#logger?.error({ err }, 'failed to invalidate cache entry')
        }
      }
      // One `undici:cache-invalidate` doc per settled invalidation; `paths` is
      // the count of invalidated paths, never the list.
      if (this.#write !== null) {
        traceSafe(
          this.#write,
          {
            id: this.#id,
            method: this.#key.method ?? null,
            url: this.#url,
            statusCode,
            paths,
            err: invalidateErr != null ? traceErr(invalidateErr) : null,
          },
          'undici:cache-invalidate',
        )
      }
    }
    return super.onHeaders(statusCode, headers, resume)
  }

  #invalidate(headers) {
    ignoreStoreResult(this.#store.delete(this.#key), this.#logger)

    const invalidated = new Set([this.#key.path])
    let base
    for (const name of ['location', 'content-location']) {
      let value = headers[name]
      if (Array.isArray(value)) {
        value = value[0]
      }
      if (typeof value !== 'string' || value === '') {
        continue
      }

      // buildURL, not `new URL(path, origin)`: a request path starting with
      // `//` would otherwise be read as a protocol-relative reference and
      // REPLACE the origin's authority — the same-origin check below would
      // then skip legitimate Location invalidations (stale-after-write) and
      // admit wrong-origin ones for sibling paths (redirect.js uses buildURL
      // for the same reason).
      base ??= buildURL(this.#key.origin, this.#key.path)
      let target
      try {
        target = new URL(value, base)
      } catch {
        continue
      }
      if (target.origin !== base.origin) {
        continue
      }

      const path = target.pathname + target.search
      if (!invalidated.has(path)) {
        invalidated.add(path)
        ignoreStoreResult(this.#store.delete({ ...this.#key, path }), this.#logger)
      }
    }

    return invalidated.size
  }
}
