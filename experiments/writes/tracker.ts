export type Watch = { value: unknown; dirty: boolean; objects: object[] }

export function writeTracking() {
  const owners = new WeakMap<object, Watch[]>()
  const operations: Record<string, number> = {}
  let writes = 0, watchedObjects = 0, indexingMs = 0, reindexes = 0
  function touch<T>(value: T, operation = 'property'): T {
    if (value !== null && typeof value === 'object') {
      const watches = owners.get(value)
      if (watches !== undefined) { operations[operation] = (operations[operation] ?? 0) + 1; writes++; for (const watch of watches) watch.dirty = true }
    }
    return value
  }
  function release(watch: Watch) {
    for (const object of watch.objects) {
      const watches = owners.get(object)!
      watches.splice(watches.indexOf(watch), 1)
      if (watches.length === 0) { owners.delete(object); watchedObjects-- }
    }
    watch.objects = []
  }
  // The caller has already validated this plain-data graph. Reindex only after
  // a write or root replacement; lifetime follows the observed cell, not history.
  function baseline(previous: Watch | undefined, value: unknown): Watch {
    if (previous !== undefined && !previous.dirty && Object.is(previous.value, value)) return previous
    const started = performance.now()
    reindexes++
    if (previous !== undefined) release(previous)
    const watch: Watch = previous ?? { value, dirty: false, objects: [] }
    watch.value = value
    const seen = new Set<object>(), pending: unknown[] = [value]
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const item = pending[cursor]
      if (item === null || typeof item !== 'object' || seen.has(item)) continue
      seen.add(item); watch.objects.push(item)
      const other = owners.get(item)
      if (other === undefined) { owners.set(item, [watch]); watchedObjects++ }
      else other.push(watch)
      if (item instanceof Map) { for (const [key, child] of item) pending.push(key, child) }
      else if (item instanceof Set) { for (const child of item) pending.push(child) }
      else for (const child of Object.values(item)) pending.push(child)
    }
    watch.dirty = false
    indexingMs += performance.now() - started
    return watch
  }
  return { touch, baseline, release, stats: () => ({ writes, watchedObjects, indexingMs, reindexes, operations }) }
}

// Installed before app code. Native operations cannot contain compiler markers;
// observing them here also covers extracted methods and .call/.apply aliases.
export function observeNativeWrites(touch: <T>(value: T, operation?: string) => T) {
  const define = Object.defineProperty
  const originals: { owner: object; key: string; descriptor: PropertyDescriptor }[] = []
  const groups: [object, string[], 'receiver' | 'first-argument'][] = [
    [Map.prototype, ['set', 'delete', 'clear'], 'receiver'],
    [Set.prototype, ['add', 'delete', 'clear'], 'receiver'],
    [Array.prototype, ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'], 'receiver'],
    [Object, ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'freeze', 'seal', 'preventExtensions'], 'first-argument'],
    [Reflect, ['set', 'deleteProperty', 'defineProperty', 'setPrototypeOf', 'preventExtensions'], 'first-argument'],
  ]
  for (const [owner, keys, target] of groups) for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!
    const original = descriptor.value as (...args: unknown[]) => unknown
    originals.push({ owner, key, descriptor })
    define(owner, key, { ...descriptor, value: function (this: unknown, ...args: unknown[]) {
      touch(target === 'receiver' ? this : args[0], key)
      // Reflect.set can write to a different receiver than its lookup target.
      if (owner === Reflect && key === 'set' && args.length > 3) touch(args[3], key)
      return Reflect.apply(original, this, args)
    } })
  }
  return () => { for (const { owner, key, descriptor } of originals) define(owner, key, descriptor) }
}
