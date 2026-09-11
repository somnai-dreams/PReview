import { expect, test } from 'bun:test'
import { instrumentWrites } from './write-compiler'
import { observeNativeWrites } from './native-writes'
import { incrementalCache } from './incremental'
import { comparison } from './values'

function watched<T extends object>(value: T) {
  const cache = incrementalCache()
  let source = structuredClone(value)
  cache.keep([{ source, target: value }])
  return {
    touch: cache.touch,
    assignment<T>(value: object, key: string, next: T) { cache.touch(value, "property", key); return next },
    matches: () => comparison(undefined, cache.phase()).matches(source, value),
    reset() { source = structuredClone(value); cache.keep([{ source, target: value }]) },
  }
}
function compiled(source: string, tracking: Pick<ReturnType<typeof incrementalCache>, 'touch'>) {
  const result = instrumentWrites('fixture.ts', source)
  expect(result.unsupported).toBe(0)
  return new Function('globalThis', new Bun.Transpiler({ loader: 'ts' }).transformSync(result.code))({ __previewWrites: tracking }) as (value: Record<string, unknown>) => unknown
}

test('markers preserve raw identity, old aliases, inserted-object writes and expression results', () => {
  const row = { count: 1 }, root = { row }, tracking = watched(root)
  const write = compiled('return x => { const old = x.row; const result = old.count++; return {same: old === x.row, result} }', tracking)
  expect(write(root)).toEqual({ same: true, result: 1 })
  expect(tracking.matches()).toBe(false)
  const inserted = { count: 5 }
  root.row = inserted
  tracking.reset()
  expect(compiled('return x => x.count += 2', tracking)(inserted)).toBe(7)
  expect(tracking.matches()).toBe(false)
})

test('evaluation order, destructuring, deletion and loop assignment remain native', () => {
  const source = `return x => {
    const order = []; const receiver = () => { order.push('receiver'); return x };
    const key = () => { order.push('key'); return 'value' }; const rhs = () => { order.push('rhs'); return 3 };
    receiver()[key()] += rhs();
    [x.other = 4] = []; ({count: x.third} = {count: 5});
    for (x.loop of [6, 7]) {};
    delete x.removed;
    return order;
  }`
  const original = new Function(source)() as (value: Record<string, unknown>) => unknown
  const a = { value: 1, removed: true }, b = structuredClone(a), tracking = watched(b)
  expect(compiled(source, tracking)(b)).toEqual(original(a))
  expect(b).toEqual(a)
  expect(tracking.matches()).toBe(false)
})

test('native observers catch extracted collection methods and preserve their return and throw behavior', () => {
  const root = { map: new Map<string, number>(), set: new Set<number>(), array: [1], object: { count: 0 } }
  const tracking = watched(root), stop = observeNativeWrites(tracking.touch)
  try {
    const set = Map.prototype.set
    expect(set.call(root.map, 'one', 1)).toBe(root.map)
    expect(tracking.matches()).toBe(false)
    tracking.reset()
    expect(Array.prototype.push.call(root.array, 2)).toBe(2)
    expect(tracking.matches()).toBe(false)
    tracking.reset()
    root.set.add(1)
    expect(tracking.matches()).toBe(false)
    tracking.reset()
    Object.assign(root.object, { count: 1 })
    expect(tracking.matches()).toBe(false)
    expect(() => set.call({}, 'bad', 1)).toThrow(TypeError)
  } finally { stop() }
})

test('a shared mutation invalidates every root proof and clearing releases the index', () => {
  const shared = { count: 0 }, live = { left: { shared }, right: shared }, source = structuredClone(live)
  const cache = incrementalCache()
  cache.keep([{source:source.left,target:live.left},{source:source.right,target:live.right}])
  cache.touch(shared, 'property', 'count'); shared.count++
  const phase = comparison(undefined, cache.phase())
  expect(phase.matches(source.left, live.left)).toBe(false)
  expect(phase.matches(source.right, live.right)).toBe(false)
  cache.clear()
  expect(cache.stats().indexedObjects).toBe(0)
})

test('coverage boundary: an uninstrumented property write can evade a retained proof', () => {
  const value = { count: 0 }, tracking = watched(value)
  value.count++
  expect(tracking.matches()).toBe(true)
})

test('nested computed receivers remain observable', () => {
  const nested = { a: { a: { count: 0 } } }, tracking = watched(nested)
  expect(compiled('return x => (x.a = x.a.a).count++', tracking)(nested)).toBe(0)
  expect(tracking.matches()).toBe(false)
})

test('instrumented restoration invalidates a nested array proof', async () => {
  const nested = [1], root = { nested }, tracking = watched(nested)
  const source = (await Bun.file(new URL('./values.ts', import.meta.url)).text()).replace(/^export /gm, '')
  const transformed = instrumentWrites('values.ts', source + '\nreturn {reconcile, restoration}')
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(transformed.code)
  const runtime = new Function('globalThis', code)({ __previewWrites: tracking }) as {
    restoration: () => unknown; reconcile: (source: unknown, target: unknown, context: unknown) => unknown
  }
  runtime.reconcile({ nested: [2] }, root, runtime.restoration())
  expect(root.nested).toBe(nested)
  expect(nested).toEqual([2])
  expect(tracking.matches()).toBe(false)
})

test('unsupported super receivers and a shadowed global are reported without breaking source', () => {
  const superWrite = instrumentWrites('fixture.ts', 'class A extends B { run() { super.value = 2 } }')
  expect(superWrite.unsupported).toBe(1)
  expect(superWrite.sites).toBe(0)
  const source = 'function write(globalThis, value) { value.count++ }'
  const shadow = instrumentWrites('fixture.ts', source)
  expect(shadow.code).toBe(source)
  expect(shadow.unsupported).toBe(1)
})

test('eval falls back before execution and preserves direct eval scope', () => {
  const events: string[] = []
  const source = `return () => { let local = 3; eval('local = 7'); return local }`
  const result = instrumentWrites('fixture.ts', source)
  expect(result.opaque).toBe(1)
  const run = new Function('globalThis', result.code)({__previewWrites: {unobserved() { events.push('fallback') }}}) as () => number
  expect(events).toEqual([])
  expect(run()).toBe(7)
  expect(events).toEqual(['fallback'])
  expect(instrumentWrites('fixture.ts', 'new Function("")').opaque).toBe(0)
})

test('ordinary constructor calls preserve receiver evaluation and field markers', () => {
  const events: string[] = []
  const result = instrumentWrites('fixture.ts', 'return x => { x.constructor().count += 2; return x.count }')
  const run = new Function('globalThis', result.code)({__previewWrites: {
    touch(value: unknown, operation: string, field: string) { events.push(operation + ':' + field); return value },
  }}) as (x: {count: number; constructor: () => unknown}) => number
  const target = {count: 1, constructor() { events.push('receiver'); return this }}
  expect(run(target)).toBe(3)
  expect(events).toEqual(['receiver', 'property:count'])
})

test('ordinary assignments retain native evaluation across rebinding, defaults and rejected writes', async () => {
  const calls: object[] = [], tracking = { touch<T>(value: T) { if (typeof value === 'object' && value !== null) calls.push(value); return value }, assignment<T>(value: object, _key: string, next: T) { calls.push(value); return next } }
  const cases = [
    'return x => { const old = x; const result = x.value = (x = {value: 2}, 7); return [old.value, x.value, result] }',
    'return x => { [x.value = 9] = [3]; ({v:x.other = 7} = {v:8}); return x }',
    'return x => { const result = x.value = (x.other = 4, 3); return [x, result] }',
    'return x => { x.value = undefined; return Object.hasOwn(x, "value") }',
    'return x => { let calls = 0; try { null.value = ++calls } catch {} return calls }',
  ]
  for (const source of cases) {
    const a: Record<string, unknown> = {}, b = {}, original = new Function(source)() as (value: object) => unknown
    calls.length = 0
    expect(compiled(source, tracking)(a)).toEqual(original(b)); expect(a).toEqual(b)
    if (source.includes('[x.value')) expect(calls).toEqual([a, a])
  }
  const source = 'return async x => { const old = x; const result = x.value = await (x = {value:2}, Promise.resolve(7)); return [old.value, x.value, result] }'
  const original = new Function(source)() as (value: object) => Promise<unknown>
  expect(await compiled(source, tracking)({})).toEqual(await original({}))
  const strict = new Function('globalThis', instrumentWrites('fixture.ts', '"use strict"; return x => x.value = 3').code)({__previewWrites: tracking}) as (value: object) => unknown
  expect(() => strict(Object.freeze({value: 3}))).toThrow(TypeError)
})

test('free receiver getters are read once and lexical receivers keep their original setter', () => {
  const events: string[] = [], target = { value: 0 }, globals = { __previewWrites: { touch<T>(value: T) { return value }, assignment<T>(_value: object, _key: string, next: T) { return next } } }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'previewTestReceiver')
  Object.defineProperty(globalThis, 'previewTestReceiver', {configurable: true, get() { events.push('receiver'); return target }})
  try {
    const transformed = instrumentWrites('fixture.ts', 'previewTestReceiver.value = 3')
    expect(transformed.code).not.toContain('.assignment(')
    new Function('globalThis', transformed.code)(globals)
    expect(events).toEqual(['receiver']); expect(target.value).toBe(3)
    events.length = 0
    const method = instrumentWrites('fixture.ts', 'class C { [previewTestReceiver.value = 4](previewTestReceiver) {} }')
    expect(method.code).not.toContain('.assignment(')
    new Function('globalThis', method.code)(globals)
    expect(events).toEqual(['receiver']); expect(target.value).toBe(4)
  } finally { if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'previewTestReceiver'); else Object.defineProperty(globalThis, 'previewTestReceiver', descriptor) }
  let reads = 0, writes = 0
  const receiver = { get value() { reads++; return 3 }, set value(_value: number) { writes++ } }
  expect(compiled('return x => x.value = 3', globals.__previewWrites)(receiver)).toBe(3)
  expect(reads).toBe(0); expect(writes).toBe(1)
})
