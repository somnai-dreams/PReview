export type Shape =
  | { kind: 'data' }
  | { kind: 'reject'; reason: string }
  | { kind: 'primitive'; name: string }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'union'; members: number[] }
  | { kind: 'array' | 'set'; item: number }
  | { kind: 'tuple'; items: number[]; required: number }
  | { kind: 'map'; key: number; value: number }
  | { kind: 'object'; fields: { name: string; optional: boolean; shape: number }[]; index: number | null }

export type Schema = { root: number; nodes: Shape[] }
type Container = Value[] | Set<Value> | Map<Value, Value> | { [key: string]: Value }
export type Value = null | undefined | string | number | boolean | Container

// `unknown` has no narrower static contract. It still must pass the supported
// data boundary; functions, accessors, DOM nodes and class instances fail it.
const dataSchema: Schema = { root: 0, nodes: [
  { kind: 'union', members: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  { kind: 'literal', value: null },
  { kind: 'primitive', name: 'undefined' },
  { kind: 'primitive', name: 'string' },
  { kind: 'primitive', name: 'number' },
  { kind: 'primitive', name: 'boolean' },
  { kind: 'array', item: 0 }, { kind: 'set', item: 0 },
  { kind: 'map', key: 10, value: 0 },
  { kind: 'object', fields: [], index: 0 },
  { kind: 'union', members: [1, 2, 3, 4, 5] },
] }

function plain(value: object): value is Record<string, unknown> {
  return Object.getPrototypeOf(value) === Object.prototype
}

export function accepts(schema: Schema, value: unknown, id = schema.root, depth = 0): value is Value {
  if (depth > 100) return false
  const shape = schema.nodes[id]
  if (shape === undefined) throw new Error('Invalid generated schema reference')
  switch (shape.kind) {
    case 'data': return accepts(dataSchema, value, 0, depth + 1)
    case 'reject': return false
    case 'primitive': return typeof value === shape.name && (typeof value !== 'number' || Number.isFinite(value))
    case 'literal': return value === shape.value
    case 'union': return shape.members.some(member => accepts(schema, value, member, depth + 1))
    case 'array':
    case 'tuple':
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0
        || Object.getOwnPropertyNames(value).length !== value.length + 1) return false
      if (shape.kind === 'tuple' && (value.length < shape.required || value.length > shape.items.length)) return false
      for (let index = 0; index < value.length; index++) {
        const field = Object.getOwnPropertyDescriptor(value, index)
        if (field === undefined || !('value' in field) || !field.enumerable
          || !accepts(schema, field.value, shape.kind === 'tuple' ? shape.items[index] : shape.item, depth + 1)) return false
      }
      return true
    case 'set':
      if (!(value instanceof Set) || Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length > 0) return false
      for (const item of value) if (!accepts(schema, item, shape.item, depth + 1)) return false
      return true
    case 'map':
      if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length > 0) return false
      for (const [key, item] of value) if (!accepts(schema, key, shape.key, depth + 1) || !accepts(schema, item, shape.value, depth + 1)) return false
      return true
    case 'object': {
      if (value === null || typeof value !== 'object' || !plain(value)) return false
      // Accessor-backed objects are executable state, not plain checkpoint data.
      if (Object.getOwnPropertySymbols(value).length > 0) return false
      const descriptors = Object.getOwnPropertyDescriptors(value)
      for (const descriptor of Object.values(descriptors)) if (!('value' in descriptor)) return false
      for (const field of shape.fields) {
        if (!Object.hasOwn(value, field.name) && field.optional) continue
        if (!accepts(schema, value[field.name], field.shape, depth + 1)) return false
      }
      for (const key of Object.keys(value)) {
        if (shape.fields.some(field => field.name === key)) continue
        if (shape.index === null || !accepts(schema, value[key], shape.index, depth + 1)) return false
      }
      return true
    }
  }
}

// Ordered collection equality matches iteration-visible UI state. The two maps
// also check shared-object identity: equal fields with broken aliases differ.
export function equal(a: unknown, b: unknown, pairs = new Map<object, object>(), reverse = new Map<object, object>(), copies?: Restoration['copies']): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const restored = copies?.get(a)
  if (restored !== undefined && restored.value !== b) return false
  const previous = pairs.get(a)
  if (previous !== undefined) return previous === b
  if (reverse.has(b)) return false
  pairs.set(a, b)
  reverse.set(b, a)
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || Object.getPrototypeOf(a) !== Map.prototype
      || Object.getPrototypeOf(b) !== Map.prototype || a.size !== b.size) return false
    return equal([...a], [...b], pairs, reverse, copies)
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || Object.getPrototypeOf(a) !== Set.prototype
      || Object.getPrototypeOf(b) !== Set.prototype || a.size !== b.size) return false
    return equal([...a], [...b], pairs, reverse, copies)
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) {
      const left = Object.getOwnPropertyDescriptor(a, index), right = Object.getOwnPropertyDescriptor(b, index)
      if (left === undefined || right === undefined || !('value' in left) || !('value' in right)
        || !equal(left.value, right.value, pairs, reverse, copies)) return false
    }
    return true
  }
  if (!plain(a) || !plain(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    const left = Object.getOwnPropertyDescriptor(a, key), right = Object.getOwnPropertyDescriptor(b, key)
    if (left === undefined || right === undefined || !('value' in left) || !('value' in right)
      || !equal(left.value, right.value, pairs, reverse, copies)) return false
  }
  return true
}

export type Restoration = { copies: Map<object, { value: Container; pass: number }>; claimed: Set<object>; pass: number }
export function restoration(): Restoration { return { copies: new Map(), claimed: new Set(), pass: 0 } }

export function matchesRestoration(source: Value, current: unknown, context: Restoration): boolean {
  return equal(source, current, new Map(), new Map(), context.copies)
}

// Reuse mutable destination containers so closures and memoized consumers keep
// seeing the restored data. One context spans all cells, preserving aliases.
export function reconcile(source: Value, destination: unknown, context: Restoration): Value {
  if (source === null || typeof source !== 'object') return source
  const previousCopy = context.copies.get(source)
  if (previousCopy !== undefined && previousCopy.pass === context.pass) return previousCopy.value
  const available = destination !== null && typeof destination === 'object' && !context.claimed.has(destination) && !Object.isFrozen(destination)
  let target: Container
  if (previousCopy !== undefined) target = previousCopy.value
  else if (Array.isArray(source)) target = available && Array.isArray(destination) && Object.isExtensible(destination)
    && Object.entries(Object.getOwnPropertyDescriptors(destination)).every(([key, field]) => 'value' in field && field.writable && (key === 'length' || field.configurable))
    ? destination : []
  else if (source instanceof Map) target = available && destination instanceof Map ? destination : new Map<Value, Value>()
  else if (source instanceof Set) target = available && destination instanceof Set ? destination : new Set<Value>()
  else target = available && plain(destination) && Object.isExtensible(destination)
    && Object.values(Object.getOwnPropertyDescriptors(destination)).every(field => 'value' in field && field.writable && field.configurable)
    ? destination as Record<string, Value> : {}
  context.copies.set(source, { value: target, pass: context.pass })
  context.claimed.add(target)
  if (Array.isArray(source) && Array.isArray(target)) {
    for (let i = 0; i < source.length; i++) target[i] = reconcile(source[i], target[i], context)
    target.length = source.length
  } else if (source instanceof Map && target instanceof Map) {
    const previous = new Map(target)
    target.clear()
    for (const [key, item] of source) target.set(reconcile(key, undefined, context), reconcile(item, previous.get(key), context))
  } else if (source instanceof Set && target instanceof Set) {
    target.clear()
    for (const item of source) target.add(reconcile(item, undefined, context))
  } else if (plain(source) && plain(target)) {
    for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key]
    for (const key of Object.keys(source)) {
      const value = reconcile(source[key], target[key], context)
      Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
    }
  } else throw new Error('Checkpoint container mismatch')
  return target
}
