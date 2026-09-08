import { expect, test } from 'bun:test'
import { instrumentWrites } from './compiler'
import { observeNativeWrites, writeTracking } from './tracker'

function compiled(source: string, tracking: ReturnType<typeof writeTracking>) {
  const result = instrumentWrites('fixture.ts', source)
  expect(result.unsupported).toBe(0)
  return new Function('globalThis', new Bun.Transpiler({ loader: 'ts' }).transformSync(result.code))({ __previewWrites: tracking }) as (value: Record<string, unknown>) => unknown
}

test('markers preserve raw identity, old aliases, inserted-object writes and expression results', () => {
  const tracking = writeTracking(), row = { count: 1 }, root = { row }
  const write = compiled('return x => { const old = x.row; const result = old.count++; return {same: old === x.row, result} }', tracking)
  const watch = tracking.baseline(undefined, root)
  expect(write(root)).toEqual({ same: true, result: 1 })
  expect(watch.dirty).toBe(true)
  const inserted = { count: 5 }
  root.row = inserted
  const next = tracking.baseline(watch, root)
  const edit = compiled('return x => x.count += 2', tracking)
  expect(edit(inserted)).toBe(7)
  expect(next.dirty).toBe(true)
})

test('evaluation order, destructuring, deletion and loop assignment remain native', () => {
  const tracking = writeTracking()
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
  const a = { value: 1, removed: true }, b = structuredClone(a)
  const watch = tracking.baseline(undefined, b)
  expect(compiled(source, tracking)(b)).toEqual(original(a))
  expect(b).toEqual(a)
  expect(watch.dirty).toBe(true)
})

test('native observers catch extracted collection methods and preserve their return/throw behavior', () => {
  const tracking = writeTracking(), stop = observeNativeWrites(tracking.touch)
  try {
    const root = { map: new Map<string, number>(), set: new Set<number>(), array: [1], object: { count: 0 } }
    const watch = tracking.baseline(undefined, root)
    const set = Map.prototype.set
    expect(set.call(root.map, 'one', 1)).toBe(root.map)
    expect(watch.dirty).toBe(true)
    tracking.baseline(watch, root)
    expect(Array.prototype.push.call(root.array, 2)).toBe(2)
    expect(watch.dirty).toBe(true)
    tracking.baseline(watch, root)
    root.set.add(1)
    expect(watch.dirty).toBe(true)
    tracking.baseline(watch, root)
    Object.assign(root.object, { count: 1 })
    expect(watch.dirty).toBe(true)
    expect(() => set.call({}, 'bad', 1)).toThrow(TypeError)
  } finally { stop() }
})

test('shared owners are notified and released graphs stop retaining subscriptions', () => {
  const tracking = writeTracking(), shared = { count: 0 }
  const left = tracking.baseline(undefined, { shared }), right = tracking.baseline(undefined, shared)
  tracking.touch(shared)
  expect(left.dirty && right.dirty).toBe(true)
  tracking.release(left); tracking.release(right)
  expect(tracking.stats().watchedObjects).toBe(0)
})

test('coverage boundary: uninstrumented property writes cannot be inferred', () => {
  const tracking = writeTracking(), value = { count: 0 }, watch = tracking.baseline(undefined, value)
  value.count++
  expect(watch.dirty).toBe(false)
})

test('object Map keys and nested computed receivers remain observable', () => {
  const tracking = writeTracking(), key = { count: 0 }, root = { map: new Map([[key, 1]]) }
  const watch = tracking.baseline(undefined, root)
  const edit = compiled('return x => { const key = [...x.map.keys()][0]; return key.count++ }', tracking)
  expect(edit(root)).toBe(0)
  expect(watch.dirty).toBe(true)
  const nested = { a: { a: { count: 0 } } }
  const nestedWatch = tracking.baseline(undefined, nested)
  expect(compiled('return x => (x.a = x.a.a).count++', tracking)(nested)).toBe(0)
  expect(nestedWatch.dirty).toBe(true)
})

test('instrumented restoration invalidates observers of a nested array alias', async () => {
  const tracking = writeTracking(), nested = [1], root = { nested }
  const watch = tracking.baseline(undefined, nested)
  const source = (await Bun.file(import.meta.dir + '/../../src/values.ts').text()).replace(/^export /gm, '')
  const transformed = instrumentWrites('values.ts', source + '\nreturn {reconcile, restoration}')
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(transformed.code)
  const runtime = new Function('globalThis', code)({ __previewWrites: tracking }) as {
    restoration: () => unknown; reconcile: (source: unknown, target: unknown, context: unknown) => unknown
  }
  runtime.reconcile({ nested: [2] }, root, runtime.restoration())
  expect(root.nested).toBe(nested)
  expect(nested).toEqual([2])
  expect(watch.dirty).toBe(true)
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
