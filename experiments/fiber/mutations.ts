// Deliberately experimental: wrapping cannot intercept writes through a raw
// alias held before observation. The tests preserve that counterexample.
export function mutations() {
  const proxies = new WeakMap<object, object>()
  const originals = new WeakMap<object, object>()
  let revision = 0
  const unwrap = (value: unknown): unknown => value !== null && typeof value === 'object' ? originals.get(value) ?? value : value
  function wrap<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value
    if (originals.has(value)) return value
    const prior = proxies.get(value)
    if (prior !== undefined) return prior as T
    const prototype = Object.getPrototypeOf(value)
    if (![Object.prototype, Array.prototype, Map.prototype, Set.prototype].includes(prototype)) return value
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        if (target instanceof Map || target instanceof Set) {
          if (key === 'size') return target.size
          if (key === 'get' && target instanceof Map) return (key: unknown) => wrap(target.get(unwrap(key)))
          if (key === 'has') return (key: unknown) => target.has(unwrap(key))
          if (key === 'set' && target instanceof Map) return (key: unknown, item: unknown) => { revision++; target.set(unwrap(key), unwrap(item)); return receiver }
          if (key === 'add' && target instanceof Set) return (item: unknown) => { revision++; target.add(unwrap(item)); return receiver }
          if (key === 'delete') return (key: unknown) => { revision++; return target.delete(unwrap(key)) }
          if (key === 'clear') return () => { revision++; target.clear() }
          if (key === 'entries' || key === Symbol.iterator && target instanceof Map) return function* () { for (const [key, item] of target.entries()) yield [wrap(key), wrap(item)] }
          if (key === 'values' || key === Symbol.iterator && target instanceof Set) return function* () { for (const item of target.values()) yield wrap(item) }
          if (key === 'keys') return function* () { for (const item of target.keys()) yield wrap(item) }
          if (key === 'forEach') return (callback: (value: unknown, key: unknown, collection: object) => void, thisArg?: unknown) => target.forEach((item, key) => callback.call(thisArg, wrap(item), wrap(key), receiver))
        }
        return wrap(Reflect.get(target, key, receiver))
      },
      set(target, key, next) { revision++; return Reflect.set(target, key, unwrap(next), target) },
      defineProperty(target, key, descriptor) { revision++; return Reflect.defineProperty(target, key, descriptor) },
      deleteProperty(target, key) { revision++; return Reflect.deleteProperty(target, key) },
      setPrototypeOf(target, next) { revision++; return Reflect.setPrototypeOf(target, next) },
      preventExtensions(target) { revision++; return Reflect.preventExtensions(target) },
    })
    proxies.set(value, proxy); originals.set(proxy, value)
    return proxy
  }
  return { wrap, revision: () => revision }
}
