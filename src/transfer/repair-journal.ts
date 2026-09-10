import type { Value } from '../values'
import type { Entry, liveProofs } from './live-proofs'
import { data } from './validate'
import { nativeWriter, type Root } from './raw-transfer'

type Before = { entry: Entry; body: object; dirty: boolean }

// Only a container actually written by application code needs a before-image.
// Its children keep their identities; writes through any child alias are
// observed independently. This journal lives for one synchronous React restore.
export function repairJournal(graph: ReturnType<typeof liveProofs>, roots: Root[], write: ReturnType<typeof nativeWriter>) {
  const before = new Map<object, Before>()
  let closed = false
  const stop = graph.observeWrites(entry => {
    if (before.has(entry.value)) return
    const value = entry.value
    let body: object
    switch (Object.getPrototypeOf(value)) {
      case Array.prototype: body = (value as Value[]).slice(); break
      case Map.prototype: body = new Map(value as Map<Value, Value>); break
      case Set.prototype: body = new Set(value as Set<Value>); break
      case Object.prototype: {
        body = {}
        for (const key of Object.keys(value)) write.define(body, key, Object.getOwnPropertyDescriptor(value, key)!.value)
        break
      }
      default: throw Error('Journal opened on unsupported data')
    }
    before.set(value, { entry, body, dirty: graph.dirty.has(entry) })
  })
  function changed() {
    if (closed) throw Error('Write journal is closed')
    const changes: Before[] = []
    for (const item of before.values()) if (!same(item.body, item.entry.value)) changes.push(item)
    return changes
  }
  function repair() {
    const changes = changed(), overrides = new Map<object, object>()
    // Recheck writability before applying any before-image. Application code
    // may freeze a container; a failed repair must not be reported as settled.
    for (const { entry, body } of changes) {
      if (!writable(entry.value, body)) return { ok: false as const, reason: 'non-writable', objects: changes.length }
      overrides.set(entry.value, body)
    }
    const phase = graph.begin(overrides)
    try {
      for (const root of roots) if (!phase.accepts(root.schema, root.value)) return { ok: false as const, reason: 'root-type', objects: changes.length }
      for (const { entry } of changes) if (!phase.accepts(data, entry.value)) return { ok: false as const, reason: 'body-type', objects: changes.length }
      phase.commit(() => {
        for (const { entry, body } of changes) restore(body, entry.value, write)
      })
      for (const item of before.values()) if (!item.dirty && same(item.body, item.entry.value)) graph.dirty.delete(item.entry)
      graph.keep(roots.map(root => root.value))
      return { ok: true as const, objects: changes.length }
    } finally { phase.close() }
  }
  return { repair, changed: () => changed().map(item => item.entry.value), objects: () => before.size,
    close() { if (closed) throw Error('Write journal is closed'); stop(); before.clear(); closed = true },
  }
}

function same(before: object, current: object) {
  if (Object.getPrototypeOf(before) !== Object.getPrototypeOf(current)) return false
  if (before instanceof Map) {
    if (Reflect.ownKeys(current).length !== 0 || before.size !== (current as Map<Value, Value>).size) return false
    const next = (current as Map<Value, Value>).entries()
    for (const [key, value] of before) { const item = next.next(); if (item.done || !Object.is(item.value[0], key) || !Object.is(item.value[1], value)) return false }
    return true
  }
  if (before instanceof Set) {
    if (Reflect.ownKeys(current).length !== 0 || before.size !== (current as Set<Value>).size) return false
    const next = (current as Set<Value>).values()
    for (const value of before) { const item = next.next(); if (item.done || !Object.is(item.value, value)) return false }
    return true
  }
  const keys = Reflect.ownKeys(before)
  if (keys.length !== Reflect.ownKeys(current).length) return false
  for (const key of keys) {
    const a = Object.getOwnPropertyDescriptor(before, key)!, b = Object.getOwnPropertyDescriptor(current, key)
    if (b === undefined || !('value' in b) || a.enumerable !== b.enumerable || !Object.is(a.value, b.value)) return false
  }
  return true
}
function writable(current: object, before: object) {
  if (Object.getPrototypeOf(current) !== Object.getPrototypeOf(before) || !Object.isExtensible(current)) return false
  for (const key of Reflect.ownKeys(current)) {
    const field = Object.getOwnPropertyDescriptor(current, key)!
    if (typeof key !== 'string' || !('value' in field) || !field.writable || !field.configurable && !(Array.isArray(current) && key === 'length')) return false
  }
  return true
}
function restore(before: object, current: object, write: ReturnType<typeof nativeWriter>) {
  if (before instanceof Map) {
    write.mapClear(current as Map<Value, Value>)
    for (const [key, value] of before) write.mapSet(current as Map<Value, Value>, key, value)
  } else if (before instanceof Set) {
    write.setClear(current as Set<Value>)
    for (const value of before) write.setAdd(current as Set<Value>, value)
  } else {
    for (const key of Object.keys(current)) if (!Object.hasOwn(before, key)) write.erase(current, key)
    for (const key of Object.keys(before)) write.define(current, key, Object.getOwnPropertyDescriptor(before, key)!.value)
    if (Array.isArray(current)) current.length = (before as Value[]).length
  }
}
