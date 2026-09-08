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
