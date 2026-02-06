import type { CacheKey, CacheResult, CacheStore, CacheValue } from './index.js'

export interface SqliteCacheStoreOptions {
  location?: string
  maxEntryCount?: number
  maxEntrySize?: number
  maxEntryTTL?: number
  db?: ConstructorParameters<typeof import('node:sqlite').DatabaseSync>[1]
}

export class SqliteCacheStore implements CacheStore {
  constructor(opts?: SqliteCacheStoreOptions)
  readonly maxEntrySize?: number
  readonly maxEntryTTL?: number
  close(): void
  get(key: CacheKey): CacheResult | undefined
  set(
    key: CacheKey,
    value: CacheValue & { body: Buffer | Buffer[] | null; start: number; end: number },
  ): void
}
