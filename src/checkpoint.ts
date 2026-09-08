import { comparison, type Value } from './values'

export type Candidate = { id: string; kind: string; value: unknown; owner: object }

// `previous` contains accepted, owned checkpoint data, never live app objects.
// Reuse only complete matches, with one consistent correspondence across cells.
// A new cell can then refer into a retained graph without copying that graph.
export function retainedCells(previous: Candidate[], current: Candidate[]) {
  const before = new Map(previous.map(cell => [cell.id, cell]))
  const retained = new Set<string>(), checked = comparison()
  for (const cell of current) {
    const old = before.get(cell.id)
    if (old !== undefined && old.kind === cell.kind && old.owner === cell.owner && checked.matches(old.value, cell.value)) retained.add(cell.id)
  }
  return { retained, matches: checked.pairs, reverse: checked.reverse }
}

type Step = string | number | { kind: 'map-key' | 'map-value' | 'set'; index: number }
type Reference = { marker: object; cell: number; path: Step[] }

// The marker side table uses object identity, so application data cannot collide
// with a magic property name. postMessage preserves these identities in its clone.
export function encodeValues(values: Value[], base: Value[], reusable: Map<object, object>) {
  const references: Reference[] = []
  const copies = new Map<object, Value>(), wanted = new Map<object, Reference>()
  const encoded = values.map(value => copy(value, copies, source => {
    const previous = reusable.get(source)
    if (previous === undefined) return undefined
    const marker = {}, reference: Reference = { marker, cell: -1, path: [] }
    references.push(reference); wanted.set(previous, reference)
    return marker
  }))
  // Find paths only for objects actually referenced by changed cells. Most warm
  // captures need none; no full-graph index is built or retained.
  const seen = new Set<object>(), path: Step[] = []
  function visit(value: Value, cell: number) {
    if (wanted.size === 0 || value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const reference = wanted.get(value)
    if (reference !== undefined) { reference.cell = cell; reference.path = path.slice(); wanted.delete(value) }
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
  return { values: encoded, references }
}

export function decodeValues(values: Value[], references: Reference[], base: Value[]): Value[] {
  if (references.length === 0) return values
  const copies = new Map<object, Value>()
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
        if (step.kind === 'set' && value instanceof Set) value = [...value][step.index]
        else if ((step.kind === 'map-key' || step.kind === 'map-value') && value instanceof Map) value = [...value][step.index]?.[step.kind === 'map-key' ? 0 : 1]
        else throw new Error('Invalid checkpoint collection reference')
      }
    }
    if (value === null || typeof value !== 'object') throw new Error('Checkpoint references must resolve to containers')
    copies.set(reference.marker, value)
  }
  return values.map(value => copy(value, copies))
}

function copy(source: Value, copies: Map<object, Value>, reuse?: (source: object) => Value | undefined): Value {
  if (source === null || typeof source !== 'object') return source
  if (copies.has(source)) return copies.get(source)
  const existing = reuse?.(source)
  if (existing !== undefined) { copies.set(source, existing); return existing }
  let target: Value
  if (Array.isArray(source)) {
    target = []; copies.set(source, target)
    for (const value of source) target.push(copy(value, copies, reuse))
  } else if (source instanceof Map) {
    target = new Map(); copies.set(source, target)
    for (const [key, value] of source) target.set(copy(key, copies, reuse), copy(value, copies, reuse))
  } else if (source instanceof Set) {
    target = new Set(); copies.set(source, target)
    for (const value of source) target.add(copy(value, copies, reuse))
  } else {
    target = {}; copies.set(source, target)
    for (const key of Object.keys(source)) Object.defineProperty(target, key, { value: copy(source[key], copies, reuse), enumerable: true, writable: true, configurable: true })
  }
  return target
}
