import type { ComparisonAcceleration } from './values'

type Proof = { source: object; target: object; records: Link[]; changed: number }
type Link = { source: object; target: object; proofs: Proof[]; differences: Set<PropertyKey> | undefined; different: boolean; fields: Set<PropertyKey> | null | undefined }
const container = (value: unknown): value is object => value !== null && typeof value === 'object'

// One frame owns one checkpoint and its verified live correspondences. Writes
// name changed fields; the index lifetime is independent of ordinary edits.
export function incrementalCache() {
  const sourceLinks = new WeakMap<object, Link>(), targetLinks = new WeakMap<object, Link>()
  const proofs = new Map<object, Proof>(), touched = new Set<Link>()
  const metrics = { indexedObjects: 0, indexedRoots: 0, fieldChecks: 0, shallowChecks: 0, hits: 0, misses: 0, drainMs: 0, indexMs: 0 }
  let enabled = true, coverage = true
  function touch<T>(value: T, operation = 'property', field?: PropertyKey): T {
    if (!container(value)) return value
    const link = targetLinks.get(value)
    if (link === undefined) return value
    touched.add(link)
    if (operation !== 'property' || field === undefined || field === '__proto__' || field === 'length' && Array.isArray(value)) link.fields = null
    else if (link.fields !== null) { link.fields ??= new Set(); link.fields.add(field) }
    return value
  }
  function corresponds(source: unknown, target: unknown): boolean {
    return Object.is(source, target) || container(source) && sourceLinks.get(source)?.target === target
  }
  function fieldMatches(link: Link, field: PropertyKey) {
    metrics.fieldChecks++
    const a = Object.getOwnPropertyDescriptor(link.source, field), b = Object.getOwnPropertyDescriptor(link.target, field)
    if (a === undefined || b === undefined) return a === b
    return 'value' in a && 'value' in b && a.enumerable === b.enumerable && corresponds(a.value, b.value)
  }
  function shallow(link: Link) {
    metrics.shallowChecks++
    const a = link.source, b = link.target
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
    const keys = Reflect.ownKeys(a)
    if (keys.length !== Reflect.ownKeys(b).length) return false
    for (const key of keys) if (!fieldMatches(link, key)) return false
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false
      const other = b.entries()
      for (const [key, value] of a) { const row = other.next().value!; if (!corresponds(key, row[0]) || !corresponds(value, row[1])) return false }
    }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) return false
      const other = b.values()
      for (const value of a) if (!corresponds(value, other.next().value)) return false
    }
    return true
  }
  function drain() {
    if (touched.size === 0) return
    const started = performance.now()
    for (const link of touched) {
      let different: boolean
      if (link.fields === null) {
        different = !shallow(link)
        // An unknown write can affect collection order, prototype or keys. Keep
        // checking this whole container until it matches the checkpoint again.
        if (!different) { link.fields = undefined; link.differences = undefined }
      } else {
        for (const key of link.fields ?? []) {
          if (fieldMatches(link, key)) link.differences?.delete(key)
          else { link.differences ??= new Set(); link.differences.add(key) }
        }
        link.fields = undefined
        different = (link.differences?.size ?? 0) !== 0
      }
      if (different !== link.different) {
        for (const proof of link.proofs) proof.changed += different ? 1 : -1
        link.different = different
      }
    }
    touched.clear()
    metrics.drainMs += performance.now() - started
  }
  function release(proof: Proof) {
    for (const link of proof.records) {
      link.proofs.splice(link.proofs.indexOf(proof), 1)
      if (link.proofs.length === 0) { sourceLinks.delete(link.source); targetLinks.delete(link.target); touched.delete(link); metrics.indexedObjects-- }
    }
    proofs.delete(proof.source)
  }
  function clear() { for (const proof of proofs.values()) release(proof) }
  function keep(roots: { source: unknown; target: unknown }[]) {
    drain()
    if (!enabled || !coverage) { clear(); return }
    const started = performance.now()
    const present = new Map<object, object>()
    for (const {source, target} of roots) if (container(source) && container(target)) present.set(source, target)
    for (const proof of proofs.values()) if (present.get(proof.source) !== proof.target || proof.changed !== 0) release(proof)
    for (const [source, target] of present) {
      if (proofs.has(source)) continue
      const proof: Proof = { source, target, records: [], changed: 0 }
      proofs.set(source, proof)
      const seen = new Set<object>(), pending: [object, object][] = [[source, target]]
      for (let cursor = 0; cursor < pending.length; cursor++) {
        const [a, b] = pending[cursor]!
        if (seen.has(a)) continue
        seen.add(a)
        let link = sourceLinks.get(a)
        const other = targetLinks.get(b)
        // A previously retained proof must never keep an incompatible alias.
        if (link !== undefined && link.target !== b || other !== undefined && other.source !== a) {
          clear()
          // This should have been rejected by the shared comparison. Fall back
          // for this checkpoint instead of certifying contradictory mappings.
          metrics.indexMs += performance.now() - started
          return
        }
        if (link === undefined) {
          link = { source: a, target: b, proofs: [], differences: undefined, different: false, fields: undefined }
          sourceLinks.set(a, link); targetLinks.set(b, link); metrics.indexedObjects++
        }
        proof.records.push(link); link.proofs.push(proof)
        function child(left: unknown, right: unknown) { if (container(left)) pending.push([left, right as object]) }
        if (a instanceof Map && b instanceof Map) {
          const values = b.entries()
          for (const [key, value] of a) { const row = values.next().value!; child(key, row[0]); child(value, row[1]) }
        } else if (a instanceof Set && b instanceof Set) {
          const values = b.values()
          for (const value of a) child(value, values.next().value)
        } else {
          for (const key of Object.keys(a)) child(Reflect.get(a, key), Reflect.get(b, key))
        }
      }
      proofs.set(source, proof); metrics.indexedRoots++
    }
    metrics.indexMs += performance.now() - started
  }
  function phase(): ComparisonAcceleration | undefined {
    drain()
    if (!enabled || !coverage || proofs.size === 0) return undefined
    const active = new Set<Proof>(), blocked = new Map<Proof, number>()
    function conflicts(source: object, target: object, difference: number) {
      const sourceLink = sourceLinks.get(source), targetLink = targetLinks.get(target)
      for (const link of [sourceLink?.target === target ? undefined : sourceLink, targetLink?.source === source ? undefined : targetLink]) {
        if (link === undefined) continue
        for (const proof of link.proofs) blocked.set(proof, (blocked.get(proof) ?? 0) + difference)
      }
    }
    return {
      match(source, target) {
        if (!container(source)) return false
        const proof = proofs.get(source)
        if (proof === undefined || proof.target !== target || proof.changed !== 0 || (blocked.get(proof) ?? 0) !== 0) { metrics.misses++; return false }
        active.add(proof); metrics.hits++; return true
      },
      get(source) { const link = sourceLinks.get(source); return link?.proofs.some(proof => active.has(proof)) ? link.target : undefined },
      reverse(target) { const link = targetLinks.get(target); return link?.proofs.some(proof => active.has(proof)) ? link.source : undefined },
      added(source, target) { conflicts(source, target, 1) },
      removed(source, target) { conflicts(source, target, -1) },
    }
  }
  return { touch, keep, phase, clear,
    configure(mode: 'full' | 'incremental') { enabled = mode === 'incremental'; if (!enabled) clear() },
    coverage(complete: boolean) { coverage = complete; if (!complete) clear() },
    stats: () => ({ ...metrics, enabled: enabled && coverage, coverage, roots: proofs.size, pending: touched.size }),
  }
}
