import { comparison, type Value, type PairMap, type ComparisonAcceleration } from './values'

export type Candidate = { id: string; kind: string; value: unknown; owner: object }

// `previous` contains accepted, owned checkpoint data, never live app objects.
// Reuse only complete matches, with one consistent correspondence across cells.
// A new cell can then refer into a retained graph without copying that graph.
export function retainedCells(previous: Candidate[], current: Candidate[], acceleration?: ComparisonAcceleration) {
  const before = new Map(previous.map(cell => [cell.id, cell]))
  const retained = new Set<string>(), checked = comparison(undefined, acceleration)
  for (const cell of current) {
    const old = before.get(cell.id)
    if (old !== undefined && old.kind === cell.kind && old.owner === cell.owner && checked.matches(old.value, cell.value)) retained.add(cell.id)
  }
  return { retained, matches: checked.pairs, reverse: {
    get: (target: object) => checked.reverse.get(target) ?? acceleration?.reuseTarget(target),
  } }
}

type Step = string | number | { kind: 'map-key' | 'map-value' | 'set'; index: number }
type Patch = { kind: 'object'; removed: string[]; entries: [string, Value][] } | { kind: 'array'; length: number; entries: [number, Value][] } | { kind: 'map'; entries: [Value, Value][] }
type Reference = { marker: object; cell: number; path: Step[]; patch?: Patch }

// The marker side table uses object identity, so application data cannot collide
// with a magic property name. postMessage preserves these identities in its clone.
export function encodeValues(values: Value[], base: Value[], reusable: Pick<PairMap, 'get'>, previous?: (source: object) => object | undefined) {
  const references: Reference[] = []
  const copies = new Map<object, Value>(), wanted = new Map<object, Reference[]>()
  let copiedObjects = 0, patchedObjects = 0
  function reference(source: object, prior: object, patch?: Patch) {
    const marker = {}, entry: Reference = { marker, cell: -1, path: [], ...(patch === undefined ? {} : { patch }) }
    references.push(entry)
    const entries = wanted.get(prior)
    if (entries === undefined) wanted.set(prior, [entry]); else entries.push(entry)
    copies.set(source, marker)
    return marker
  }
  function same(current: Value, old: Value) { return Object.is(current, old) || current !== null && typeof current === 'object' && reusable.get(current) === old }
  function encode(source: Value): Value {
    if (source === null || typeof source !== 'object') return source
    if (copies.has(source)) return copies.get(source)
    const retained = reusable.get(source)
    if (retained !== undefined) return reference(source, retained)
    const prior = previous?.(source)
    if (Array.isArray(source) && Array.isArray(prior)) {
      const patch: Patch = { kind: 'array', length: source.length, entries: [] }
      const marker = reference(source, prior, patch); patchedObjects++
      for (let index = 0; index < source.length; index++) if (!Object.hasOwn(prior, index) || !same(source[index], prior[index])) patch.entries.push([index, encode(source[index])])
      return marker
    }
    if (source instanceof Map && prior instanceof Map && source.size === prior.size) {
      const keys = prior.keys()
      let ordered = true
      for (const key of source.keys()) if (!same(key, keys.next().value)) { ordered = false; break }
      if (ordered) {
        const patch: Patch = { kind: 'map', entries: [] }, marker = reference(source, prior, patch)
        patchedObjects++
        const entries = prior.entries()
        for (const [key, value] of source) { const old = entries.next().value!; if (!same(value, old[1])) patch.entries.push([encode(key), encode(value)]) }
        return marker
      }
    }
    if (prior !== undefined && Object.getPrototypeOf(source) === Object.prototype && Object.getPrototypeOf(prior) === Object.prototype) {
      const patch: Patch = { kind: 'object', removed: Object.keys(prior).filter(key => !Object.hasOwn(source, key)), entries: [] }
      const marker = reference(source, prior, patch); patchedObjects++
      for (const key of Object.keys(source)) if (!Object.hasOwn(prior, key) || !same(Reflect.get(source, key), Reflect.get(prior, key))) patch.entries.push([key, encode(Reflect.get(source, key))])
      return marker
    }
    copiedObjects++
    let target: Value
    if (Array.isArray(source)) { target = []; copies.set(source, target); for (const value of source) target.push(encode(value)) }
    else if (source instanceof Map) { target = new Map(); copies.set(source, target); for (const [key, value] of source) target.set(encode(key), encode(value)) }
    else if (source instanceof Set) { target = new Set(); copies.set(source, target); for (const value of source) target.add(encode(value)) }
    else { target = {}; copies.set(source, target); for (const key of Object.keys(source)) Object.defineProperty(target, key, { value: encode(source[key]), enumerable: true, writable: true, configurable: true }) }
    return target
  }
  const encoded = values.map(encode)
  // Find paths only for objects actually referenced by changed cells. Most warm
  // captures need none; no full-graph index is built or retained.
  const seen = new Set<object>(), path: Step[] = []
  function visit(value: Value, cell: number) {
    if (wanted.size === 0 || value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const references = wanted.get(value)
    if (references !== undefined) { for (const reference of references) { reference.cell = cell; reference.path = path.slice() }; wanted.delete(value) }
    function child(item: Value, step: Step) { path.push(step); visit(item, cell); path.pop() }
    if (value instanceof Map) {
      let index = 0
      for (const [key, item] of value) { if (wanted.size === 0) break; child(key, { kind: 'map-key', index }); child(item, { kind: 'map-value', index }); index++ }
    } else if (value instanceof Set) {
      let index = 0
      for (const item of value) { if (wanted.size === 0) break; child(item, { kind: 'set', index: index++ }) }
    } else if (Array.isArray(value)) {
      for (let index = 0; index < value.length && wanted.size > 0; index++) child(value[index], index)
    } else {
      for (const key of Object.keys(value)) { if (wanted.size === 0) break; child(value[key], key) }
    }
  }
  for (let cell = 0; cell < base.length && wanted.size > 0; cell++) visit(base[cell], cell)
  if (wanted.size !== 0) throw new Error('Checkpoint reference is not reachable')
  return { values: encoded, references, copiedObjects, patchedObjects, reusedObjects: references.length - patchedObjects }
}

export function decodeValues(values: Value[], references: Reference[], base: Value[]): Value[] {
  if (references.length === 0) return values
  const copies = new Map<object, Value>(), collections = new Map<object, Value[]>()
  for (const reference of references) {
    let value = base[reference.cell]
    if (!Number.isSafeInteger(reference.cell) || reference.cell < 0 || reference.cell >= base.length) throw new Error('Invalid checkpoint cell reference')
    for (const step of reference.path) {
      if (value === null || typeof value !== 'object') throw new Error('Invalid checkpoint reference path')
      if (typeof step === 'string' || typeof step === 'number') {
        const field = Object.getOwnPropertyDescriptor(value, step)
        if (field === undefined || !('value' in field)) throw new Error('Invalid checkpoint field reference')
        value = field.value
      } else {
        if (!Number.isSafeInteger(step.index) || step.index < 0) throw new Error('Invalid checkpoint collection index')
        const isSet = step.kind === 'set' && value instanceof Set
        const isMap = (step.kind === 'map-key' || step.kind === 'map-value') && value instanceof Map
        if (!isSet && !isMap) throw new Error('Invalid checkpoint collection reference')
        let entries = collections.get(value)
        if (entries === undefined) { entries = isSet ? [...value as Set<Value>] : [...value as Map<Value, Value>]; collections.set(value, entries) }
        value = isSet ? entries[step.index] : (entries[step.index] as Value[] | undefined)?.[step.kind === 'map-key' ? 0 : 1]
      }
    }
    if (value === null || typeof value !== 'object') throw new Error('Checkpoint references must resolve to containers')
    let target = value
    switch (reference.patch?.kind) {
      case undefined: break
      case 'array': if (!Array.isArray(value)) throw new Error('Invalid array patch'); target = value.slice(); break
      case 'map': if (!(value instanceof Map)) throw new Error('Invalid map patch'); target = new Map(value); break
      case 'object': if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid object patch'); target = { ...value }; break
    }
    copies.set(reference.marker, target)
  }
  // Allocate every patched container first. Applying changes can then reconnect
  // aliases between patches without ever mutating the previous checkpoint.
  for (const reference of references) {
    const patch = reference.patch
    if (patch === undefined) continue
    const target = copies.get(reference.marker)!
    switch (patch.kind) {
      case 'array': {
        if (!Number.isSafeInteger(patch.length) || patch.length < 0 || patch.length > 4294967295) throw new Error('Invalid array patch length')
        const array = target as Value[]; array.length = patch.length
        for (const [index, value] of patch.entries) {
          if (!Number.isSafeInteger(index) || index < 0 || index >= patch.length) throw new Error('Invalid array patch index')
          array[index] = copy(value, copies)
        }
        break
      }
      case 'map': for (const [key, value] of patch.entries) (target as Map<Value, Value>).set(copy(key, copies), copy(value, copies)); break
      case 'object': {
        const object = target as Record<string, Value>
        for (const key of patch.removed) delete object[key]
        for (const [key, value] of patch.entries) Object.defineProperty(object, key, { value: copy(value, copies), enumerable: true, writable: true, configurable: true })
        break
      }
    }
  }
  return values.map(value => copy(value, copies))
}

function copy(source: Value, copies: Map<object, Value>): Value {
  if (source === null || typeof source !== 'object') return source
  if (copies.has(source)) return copies.get(source)
  let target: Value
  if (Array.isArray(source)) {
    target = []; copies.set(source, target)
    for (const value of source) target.push(copy(value, copies))
  } else if (source instanceof Map) {
    target = new Map(); copies.set(source, target)
    for (const [key, value] of source) target.set(copy(key, copies), copy(value, copies))
  } else if (source instanceof Set) {
    target = new Set(); copies.set(source, target)
    for (const value of source) target.add(copy(value, copies))
  } else {
    target = {}; copies.set(source, target)
    for (const key of Object.keys(source)) Object.defineProperty(target, key, { value: copy(source[key], copies), enumerable: true, writable: true, configurable: true })
  }
  return target
}
