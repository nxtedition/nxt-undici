const STORE_COUNTERS = [
  'gets',
  'hits',
  'sets',
  'writes',
  'deletes',
  'flushes',
  'gcs',
  'clears',
  'evictions',
  'errors',
  'pending',
  'size',
  'usedSize',
  'maxSize',
]

export class CacheStats {
  #hits = 0
  #misses = 0
  #revalidations = 0
  #bypasses = 0
  #storeRefs = new Set()
  #stores = new WeakMap()
  #registry = new FinalizationRegistry((ref) => this.#storeRefs.delete(ref))

  hit() {
    this.#hits++
  }

  miss() {
    this.#misses++
  }

  revalidate() {
    this.#revalidations++
  }

  bypass() {
    this.#bypasses++
  }

  trackStore(store) {
    if ((typeof store !== 'object' || store === null) && typeof store !== 'function') {
      return
    }
    if (this.#stores.has(store)) {
      return
    }

    const ref = new WeakRef(store)
    this.#stores.set(store, ref)
    this.#storeRefs.add(ref)
    this.#registry.register(store, ref, store)
  }

  snapshot() {
    const lookups = this.#hits + this.#misses
    const snapshot = {
      hits: this.#hits,
      misses: this.#misses,
      revalidations: this.#revalidations,
      bypasses: this.#bypasses,
      hitRate: lookups === 0 ? 0 : this.#hits / lookups,
    }

    const store = { stores: 0 }
    for (const counter of STORE_COUNTERS) {
      store[counter] = 0
    }

    for (const ref of this.#storeRefs) {
      const target = ref.deref()
      if (target === undefined) {
        this.#storeRefs.delete(ref)
        continue
      }

      let stats
      try {
        stats = target.stats
      } catch {
        continue
      }
      if (stats == null || typeof stats !== 'object') {
        continue
      }

      store.stores++
      for (const counter of STORE_COUNTERS) {
        const value = stats[counter]
        if (typeof value === 'number' && Number.isFinite(value)) {
          store[counter] += value
        }
      }
    }

    if (store.stores > 0) {
      store.hitRate = store.gets === 0 ? 0 : store.hits / store.gets
      snapshot.store = store
    }

    return snapshot
  }
}
