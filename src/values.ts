export type PairMap = { get: (key: object) => object | undefined; has: (key: object) => boolean; set: (key: object, value: object) => void; delete: (key: object) => void }
export type ComparisonAcceleration = {
  baseTarget: (target: object) => object | undefined
  mark: () => number
  rollback: (mark: number) => void
  reuseSource: (source: object) => object | undefined
  reuseTarget: (target: object) => object | undefined
  match: (source: unknown, target: unknown) => boolean
  get: (source: object) => object | undefined
  reverse: (target: object) => object | undefined
  added: (source: object, target: object) => void
  removed: (source: object, target: object) => void
}
export type Construction = {
  start: (source: object, target: object, pass: number) => void
  finish: (source: object) => void
  adopt: (source: unknown, target: unknown) => void
  get: (source: object) => { value: object; pass: number } | undefined
  source: (target: object) => object | undefined
  previous: (source: object) => object | undefined
  commit: (values: { source: unknown; target: unknown }[]) => void
  close: () => void
}
type Copies = { get: (source: object) => { value: Container; pass: number } | undefined; set: (source: object, copy: { value: Container; pass: number }) => void; changed: Map<object, { value: Container; pass: number }> }

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
const dataSchema: Schema = { root: 0, nodes: [{ kind: 'data' }] }

function acceptsData(value: unknown, depth: number, validation?: Validation): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'undefined': case 'string': case 'boolean': return true
    case 'number': return Number.isFinite(value)
    case 'object': break
    default: return false
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) return false
    for (let i = 0; i < value.length; i++) {
      const field = Object.getOwnPropertyDescriptor(value, i)
      if (field === undefined || !('value' in field) || !field.enumerable || !accepts(dataSchema, field.value, 0, depth + 1, validation)) return false
    }
    return true
  }
  if (value instanceof Map) {
    if (Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length !== 0) return false
    for (const [key, item] of value) {
      if (key !== null && typeof key === 'object' || !accepts(dataSchema, key, 0, depth + 1, validation) || !accepts(dataSchema, item, 0, depth + 1, validation)) return false
    }
    return true
  }
  if (value instanceof Set) {
    if (Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length !== 0) return false
    for (const item of value) if (!accepts(dataSchema, item, 0, depth + 1, validation)) return false
    return true
  }
  if (!plain(value) || Object.getOwnPropertySymbols(value).length !== 0) return false
  for (const key of Object.getOwnPropertyNames(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in field) || !field.enumerable || !accepts(dataSchema, field.value, 0, depth + 1, validation)) return false
  }
  return true
}

function plain(value: object): value is Record<string, unknown> {
  return Object.getPrototypeOf(value) === Object.prototype
}

type Validation = { known: (schema: Schema, value: object, id: number) => boolean; remember: (schema: Schema, value: object, id: number) => void }
export function accepts(schema: Schema, value: unknown, id = schema.root, depth = 0, validation?: Validation): value is Value {
  if (depth > 100) return false
  if (value !== null && typeof value === 'object' && validation?.known(schema, value, id)) return true
  const valid = acceptsShape(schema, value, id, depth, validation)
  if (valid && value !== null && typeof value === 'object') validation?.remember(schema, value, id)
  return valid
}
function acceptsShape(schema: Schema, value: unknown, id: number, depth: number, validation?: Validation): value is Value {
  const shape = schema.nodes[id]
  if (shape === undefined) throw new Error('Invalid generated schema reference')
  switch (shape.kind) {
    case 'data': return acceptsData(value, depth, validation)
    case 'reject': return false
    case 'primitive': return typeof value === shape.name && (typeof value !== 'number' || Number.isFinite(value))
    case 'literal': return value === shape.value
    case 'union': return shape.members.some(member => accepts(schema, value, member, depth + 1, validation))
    case 'array':
    case 'tuple':
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0
        || Object.getOwnPropertyNames(value).length !== value.length + 1) return false
      if (shape.kind === 'tuple' && (value.length < shape.required || value.length > shape.items.length)) return false
      for (let index = 0; index < value.length; index++) {
        const field = Object.getOwnPropertyDescriptor(value, index)
        if (field === undefined || !('value' in field) || !field.enumerable
          || !accepts(schema, field.value, shape.kind === 'tuple' ? shape.items[index] : shape.item, depth + 1, validation)) return false
      }
      return true
    case 'set':
      if (!(value instanceof Set) || Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length > 0) return false
      for (const item of value) if (!accepts(schema, item, shape.item, depth + 1, validation)) return false
      return true
    case 'map':
      if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length > 0) return false
      for (const [key, item] of value) if (!accepts(schema, key, shape.key, depth + 1, validation) || !accepts(schema, item, shape.value, depth + 1, validation)) return false
      return true
    case 'object': {
      if (value === null || typeof value !== 'object' || !plain(value)) return false
      // Accessor-backed objects are executable state, not plain checkpoint data.
      if (Object.getOwnPropertySymbols(value).length > 0) return false
      // Most records contain only declared fields: validate them without a
      // descriptor table. TypeScript object types also allow extra properties;
      // accept those only when they satisfy the plain-data boundary.
      if (shape.index === null) {
        let present = 0
        for (const field of shape.fields) {
          const descriptor = Object.getOwnPropertyDescriptor(value, field.name)
          if (descriptor === undefined) {
            if (!field.optional && !accepts(schema, undefined, field.shape, depth + 1, validation)) return false
          } else {
            if (!('value' in descriptor) || !descriptor.enumerable || !accepts(schema, descriptor.value, field.shape, depth + 1, validation)) return false
            present++
          }
        }
        const keys = Object.getOwnPropertyNames(value)
        if (keys.length === present) return true
        const declared = new Set(shape.fields.map(field => field.name))
        for (const key of keys) {
          if (declared.has(key)) continue
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!
          if (!('value' in descriptor) || !descriptor.enumerable || !accepts(dataSchema, descriptor.value, 0, depth + 1, validation)) return false
        }
        return true
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      for (const field of shape.fields) {
        const descriptor = Object.hasOwn(descriptors, field.name) ? descriptors[field.name] : undefined
        if (descriptor === undefined) {
          if (!field.optional && !accepts(schema, undefined, field.shape, depth + 1, validation)) return false
          continue
        }
        if (!('value' in descriptor) || !descriptor.enumerable || !accepts(schema, descriptor.value, field.shape, depth + 1, validation)) return false
        delete descriptors[field.name]
      }
      for (const descriptor of Object.values(descriptors)) {
        if (!('value' in descriptor) || !descriptor.enumerable || !accepts(schema, descriptor.value, shape.index, depth + 1, validation)) return false
      }
      return true
    }
  }
}

// Ordered collection equality matches iteration-visible UI state. The two maps
// also check shared-object identity: equal fields with broken aliases differ.
// knownSource is reserved for previously validated, owned checkpoint data. The
// live destination still receives descriptor/prototype checks on every visit.
export function equal(a: unknown, b: unknown, pairs: PairMap = new Map<object, object>(), reverse: PairMap = new Map<object, object>(), copies?: Restoration['copies'], knownSource = false, added?: object[], acceleration?: ComparisonAcceleration): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const restored = copies?.get(a)
  if (restored !== undefined && restored.value !== b) return false
  const previous = pairs.get(a)
  if (previous !== undefined) return previous === b
  if (reverse.has(b)) return false
  if (acceleration?.match(a, b)) return true
  pairs.set(a, b)
  reverse.set(b, a)
  added?.push(a)
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || Object.getPrototypeOf(a) !== Map.prototype
      || Object.getPrototypeOf(b) !== Map.prototype || Reflect.ownKeys(a).length !== 0 || Reflect.ownKeys(b).length !== 0 || a.size !== b.size) return false
    const other = b.entries()
    for (const [key, value] of a) {
      const item = other.next().value!
      if (!equal(key, item[0], pairs, reverse, copies, knownSource, added, acceleration) || !equal(value, item[1], pairs, reverse, copies, knownSource, added, acceleration)) return false
    }
    return true
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || Object.getPrototypeOf(a) !== Set.prototype
      || Object.getPrototypeOf(b) !== Set.prototype || Reflect.ownKeys(a).length !== 0 || Reflect.ownKeys(b).length !== 0 || a.size !== b.size) return false
    const other = b.values()
    for (const value of a) if (!equal(value, other.next().value, pairs, reverse, copies, knownSource, added, acceleration)) return false
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || Object.getPrototypeOf(a) !== Array.prototype || Object.getPrototypeOf(b) !== Array.prototype
      || a.length !== b.length || Reflect.ownKeys(a).length !== a.length + 1 || Reflect.ownKeys(b).length !== b.length + 1) return false
    for (let index = 0; index < a.length; index++) {
      const left = knownSource ? { value: a[index], enumerable: true } : Object.getOwnPropertyDescriptor(a, index), right = Object.getOwnPropertyDescriptor(b, index)
      if (left === undefined || right === undefined || !('value' in left) || !('value' in right) || !left.enumerable || !right.enumerable
        || !equal(left.value, right.value, pairs, reverse, copies, knownSource, added, acceleration)) return false
    }
    return true
  }
  if (!plain(a) || !plain(b)) return false
  const keys = knownSource ? Object.keys(a) : Reflect.ownKeys(a)
  if (keys.length !== Reflect.ownKeys(b).length) return false
  for (const key of keys) {
    if (typeof key !== 'string') return false
    const left = knownSource ? { value: a[key], enumerable: true } : Object.getOwnPropertyDescriptor(a, key), right = Object.getOwnPropertyDescriptor(b, key)
    if (left === undefined || right === undefined || !('value' in left) || !('value' in right) || !left.enumerable || !right.enumerable
      || !equal(left.value, right.value, pairs, reverse, copies, knownSource, added, acceleration)) return false
  }
  return true
}

// One synchronous read phase owns this comparison. Discard it before any app
// writes/commit; successful shared subgraphs can then be visited just once.
export function comparison(copies?: Restoration['copies'], acceleration?: ComparisonAcceleration) {
  const written = new Map<object, object>(), reversed = new Map<object, object>()
  if (acceleration !== undefined && copies !== undefined) for (const [source, copy] of copies.changed) acceleration.added(source, copy.value)
  const pairs: PairMap = {
    get: key => written.get(key) ?? acceleration?.get(key),
    has: key => written.has(key) || acceleration?.get(key) !== undefined,
    set: (key, value) => { written.set(key, value); acceleration?.added(key, value) },
    delete: key => { const value = written.get(key); if (value !== undefined) acceleration?.removed(key, value); written.delete(key) },
  }
  const reverse: PairMap = {
    get: key => reversed.get(key) ?? acceleration?.reverse(key),
    has: key => reversed.has(key) || acceleration?.reverse(key) !== undefined,
    set: (key, value) => { reversed.set(key, value) }, delete: key => { reversed.delete(key) },
  }
  function matches(source: unknown, current: unknown): boolean {
    const copy = source !== null && typeof source === 'object' ? copies?.get(source) : undefined
    if (copy !== undefined && copy.value !== current) return false
    if (acceleration?.match(source, current)) return true
    const mark = acceleration?.mark()
    const added: object[] = []
    if (equal(source, current, pairs, reverse, copies, true, added, acceleration)) return true
    if (mark !== undefined) acceleration!.rollback(mark)
    for (const value of added) { reverse.delete(pairs.get(value)!); pairs.delete(value) }
    return false
  }
  return { matches, pairs, reverse }
}

// Only owned checkpoint copies may enter this cache. Live values always require
// a fresh comparison or validation. Weak keys do not retain old checkpoints.
export function checkpointValidation() {
  const validated = new WeakMap<Schema, Map<number, WeakSet<object>>>()
  const owned: Validation = {
    known: (schema, value, id) => validated.get(schema)?.get(id)?.has(value) ?? false,
    remember(schema, value, id) {
      let nodes = validated.get(schema)
      if (nodes === undefined) { nodes = new Map(); validated.set(schema, nodes) }
      let values = nodes.get(id)
      if (values === undefined) { values = new WeakSet(); nodes.set(id, values) }
      values.add(value)
    },
  }
  function acceptsCopy(schema: Schema, value: unknown): value is Value { return accepts(schema, value, schema.root, 0, owned) }
  function acceptsLive(schema: Schema, value: unknown, previous: Pick<PairMap, 'get'>): value is Value {
    return accepts(schema, value, schema.root, 0, {
      known(schema, value, id) { const copy = previous.get(value); return copy !== undefined && accepts(schema, copy, id, 0, owned) },
      remember() {},
    })
  }
  function remember(schema: Schema, value: Value) {
    if (!acceptsCopy(schema, value)) throw new Error('Captured checkpoint failed validation')
  }

  // Validation completes children before their parent. Construct that exact
  // owned copy here and attach the successful schema proof to it once.
  function capturePhase(previous: Pick<PairMap, 'get'>, construction?: Construction) {
    const fallback = construction === undefined ? new Map<object, object>() : undefined
    let count = 0
    const reused = new WeakSet<object>()
    function copied(value: object) {
      const current = construction?.source(value) ?? fallback?.get(value)
      if (current !== undefined) return current
      const prior = previous.get(value)
      if (prior !== undefined) reused.add(prior)
      return prior
    }
    function copyOf(value: unknown): Value {
      if (value === null || typeof value !== 'object') return value as Value
      const copy = copied(value)
      if (copy === undefined) throw new Error('Missing validated child')
      construction?.adopt(copy, value)
      return copy as Value
    }
    const phase: Validation = {
      known(schema, value, id) {
        const copy = copied(value)
        return copy !== undefined && accepts(schema, copy, id, 0, owned)
      },
      remember(schema, value, id) {
        let copy = copied(value)
        if (copy === undefined) {
          if (Array.isArray(value)) copy = value.map(copyOf)
          else if (value instanceof Map) { const map = new Map<Value, Value>(); for (const [key, item] of value) map.set(copyOf(key), copyOf(item)); copy = map }
          else if (value instanceof Set) { const set = new Set<Value>(); for (const item of value) set.add(copyOf(item)); copy = set }
          else { const object: Record<string, Value> = {}; for (const key of Object.keys(value)) Object.defineProperty(object, key, { value: copyOf(Reflect.get(value, key)), enumerable: true, configurable: true, writable: true }); copy = object }
          if (construction === undefined) fallback!.set(value, copy)
          else { construction.start(copy, value, 0); construction.finish(copy) }
          count++
        }
        owned.remember(schema, copy, id)
      },
    }
    return { accepts: (schema: Schema, value: unknown) => accepts(schema, value, schema.root, 0, phase), value: copyOf, reused: (value: object) => reused.has(value), count: () => count }
  }
  return { accepts: acceptsCopy, acceptsLive, remember, capturePhase }
}

export type Restoration = { copies: Copies; claimed: { has: (value: object) => boolean; add: (value: object) => void }; pass: number; settled: Pick<PairMap, 'get'> | undefined; construction: Construction | undefined }
export function restoration(matches: Pick<PairMap, 'get'> = new Map(), reverse: Pick<PairMap, 'has'> = new Map(), acceleration?: ComparisonAcceleration, construction?: Construction): Restoration {
  const changed: Copies['changed'] = new Map(), claimed = new Set<object>()
  const copies: Copies = {
    changed,
    get(source) {
      const copy = construction?.get(source) ?? changed.get(source)
      if (copy !== undefined) return copy as { value: Container; pass: number }
      const value = matches.get(source) ?? acceleration?.reuseSource(source)
      if (value === undefined) return undefined
      return { value: value as Container, pass: 0 }
    },
    set(source, copy) {
      if (construction === undefined) { changed.set(source, copy); acceleration?.added(source, copy.value) }
      else construction.start(source, copy.value, copy.pass)
    },
  }
  return { copies, claimed: { has: value => claimed.has(value) || construction?.source(value) !== undefined || reverse.has(value) || acceleration?.reverse(value) !== undefined, add: value => { if (construction === undefined) claimed.add(value) } }, pass: 0, settled: undefined, construction }
}

export function matchesRestoration(source: Value, current: unknown, context: Restoration): boolean {
  return equal(source, current, new Map(), new Map(), context.copies, true)
}

// Reuse mutable destination containers so closures and memoized consumers keep
// seeing the restored data. One context spans all cells, preserving aliases.
export function reconcile(source: Value, destination: unknown, context: Restoration): Value {
  if (source === null || typeof source !== 'object') return source
  const previousCopy = context.copies.get(source)
  if (previousCopy !== undefined && (previousCopy.pass === context.pass || context.settled?.get(source) === previousCopy.value)) return previousCopy.value
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
  context.construction?.finish(source)
  return target
}
