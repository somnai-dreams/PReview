import { instrumentGeneratedFunction } from './write-compiler'

// Install before application code so aliases and .constructor use the same
// boundary. Application objects and returned functions are not proxied.
export function observeGeneratedFunctions(unobserved: () => void) {
  const define = Object.defineProperty, getPrototype = Object.getPrototypeOf, setPrototype = Object.setPrototypeOf
  const stringify = Function.prototype.toString
  const constructors = [Function, getPrototype(async function () {}).constructor, getPrototype(function* () {}).constructor, getPrototype(async function* () {}).constructor] as FunctionConstructor[]
  const originals: { owner: object; key: string; descriptor: PropertyDescriptor }[] = []
  const metrics = { created: 0, transformed: 0, fallback: 0, sourceCharacters: 0, compileMs: 0 }
  function replace(owner: object, key: string, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!
    originals.push({ owner, key, descriptor })
    define(owner, key, { ...descriptor, value })
  }
  for (const native of constructors) {
    function create(args: unknown[], newTarget: Function) {
      const started = performance.now()
      try {
        // Let the engine perform coercion, syntax validation and CSP checks.
        // This also resolves a custom newTarget.prototype exactly once.
        const original = Reflect.construct(native, args, newTarget) as Function
        const text = Reflect.apply(stringify, original, []) as string
        metrics.created++; metrics.sourceCharacters += text.length
        const result = instrumentGeneratedFunction(text)
        switch (result.kind) {
          case 'unchanged': return original
          case 'unsupported': metrics.fallback++; unobserved(); return original
          case 'instrumented': {
            // Reconstruct with the same intrinsic, not a factory returning a
            // named function expression (which would introduce a self binding).
            const observed = Reflect.construct(native, [result.parameters, result.body]) as Function
            setPrototype(observed, getPrototype(original))
            metrics.transformed++
            return observed
          }
        }
      } finally { metrics.compileMs += performance.now() - started }
    }
    const observed = new Proxy(native, {
      apply(_target, _receiver, args) { return create(args, native) },
      construct(_target, args, newTarget) { return create(args, newTarget) },
    })
    replace(native.prototype, 'constructor', observed)
    if (native === constructors[0]) replace(globalThis, 'Function', observed)
  }
  return { stats: () => ({ ...metrics }), stop() { for (const { owner, key, descriptor } of originals) define(owner, key, descriptor) } }
}
