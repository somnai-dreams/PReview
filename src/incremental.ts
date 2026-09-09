import type { ComparisonAcceleration } from './values'

type Link = { source: object; target: object; parents: Edges; children: Edges; roots: number; different: boolean; dirtyChildren: number; differences: Set<PropertyKey> | undefined; fields: Set<PropertyKey> | null | undefined }
// Most data objects have one parent and zero or one child. Keep those edges
// directly; allocate a list only for actual branching or shared ownership.
type Edges = Link | Link[] | undefined
function edgeCount(edges: Edges) { return edges === undefined ? 0 : Array.isArray(edges) ? edges.length : 1 }
function edgeAt(edges: Edges, index: number): Link { return Array.isArray(edges) ? edges[index]! : edges! }
function appendEdge(edges: Edges, link: Link): Edges {
  if (edges === undefined) return link
  if (Array.isArray(edges)) { edges.push(link); return edges }
  return [edges, link]
}
function removeEdge(edges: Edges, link: Link): Edges {
  if (!Array.isArray(edges)) return undefined
  edges.splice(edges.indexOf(link), 1)
  return edges.length === 1 ? edges[0] : edges
}
const container = (value: unknown): value is object => value !== null && typeof value === 'object'
const dirty = (link: Link) => link.different || link.dirtyChildren !== 0

// One link per owned/live object pair. Edges propagate changes to ancestors,
// while unchanged siblings retain their own proof and can be reused separately.
export function incrementalCache() {
  const sourceLinks = new WeakMap<object, Link>(), targetLinks = new WeakMap<object, Link>()
  const touched = new Set<Link>()
  let roots: Link[] = [], enabled = true, coverage = true
  const metrics = { indexedObjects: 0, indexedRoots: 0, fieldChecks: 0, shallowChecks: 0, hits: 0, misses: 0, drainMs: 0, indexMs: 0 }
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
  function changed(link: Link, difference: number) {
    for (let index = 0; index < edgeCount(link.parents); index++) {
      const parent = edgeAt(link.parents, index)
      const before = dirty(parent)
      parent.dirtyChildren += difference
      if (before !== dirty(parent)) changed(parent, dirty(parent) ? 1 : -1)
    }
  }
  function drain() {
    if (touched.size === 0) return
    const started = performance.now()
    for (const link of touched) {
      let different: boolean
      if (link.fields === null) {
        different = !shallow(link)
        if (!different) { link.fields = undefined; link.differences = undefined }
      } else {
        for (const key of link.fields ?? []) {
          if (fieldMatches(link, key)) link.differences?.delete(key)
          else { link.differences ??= new Set(); link.differences.add(key) }
        }
        link.fields = undefined
        different = (link.differences?.size ?? 0) !== 0
      }
      const before = dirty(link)
      link.different = different
      if (before !== dirty(link)) changed(link, dirty(link) ? 1 : -1)
    }
    touched.clear()
    metrics.drainMs += performance.now() - started
  }
  function release(link: Link) {
    if (link.roots !== 0 || link.parents !== undefined) return
    if (sourceLinks.get(link.source) === link) sourceLinks.delete(link.source)
    if (targetLinks.get(link.target) === link) targetLinks.delete(link.target)
    touched.delete(link); metrics.indexedObjects--
    for (let index = 0; index < edgeCount(link.children); index++) {
      const child = edgeAt(link.children, index)
      child.parents = removeEdge(child.parents, link)
      release(child)
    }
  }
  function clear() {
    for (const root of roots) { root.roots--; release(root) }
    roots = []
  }
  function keep(values: { source: unknown; target: unknown }[]) {
    drain()
    if (!enabled || !coverage) { clear(); return }
    const started = performance.now(), next: Link[] = [], built = new Map<object, Link>(), targets = new Map<object, object>()
    function visit(source: object, target: object): Link {
      const existing = built.get(source)
      if (existing !== undefined) {
        if (existing.target !== target) throw new Error('Conflicting checkpoint aliases')
        return existing
      }
      const previous = sourceLinks.get(source)
      if (previous !== undefined && previous.target === target && !dirty(previous)) return previous
      const used = targets.get(target)
      if (used !== undefined && used !== source) throw new Error('Conflicting checkpoint identities')
      targets.set(target, source)
      const link: Link = { source, target, parents: undefined, children: undefined, roots: 0, different: false, dirtyChildren: 0, differences: undefined, fields: undefined }
      built.set(source, link); sourceLinks.set(source, link); targetLinks.set(target, link); metrics.indexedObjects++
      function child(a: unknown, b: unknown) {
        if (!container(a)) return
        if (!container(b)) throw new Error('Invalid checkpoint correspondence')
        const entry = visit(a, b)
        link.children = appendEdge(link.children, entry); entry.parents = appendEdge(entry.parents, link)
      }
      if (source instanceof Map && target instanceof Map) {
        const other = target.entries()
        for (const [key, value] of source) { const row = other.next().value!; child(key, row[0]); child(value, row[1]) }
      } else if (source instanceof Set && target instanceof Set) {
        const other = target.values()
        for (const value of source) child(value, other.next().value)
      } else {
        for (const key of Object.keys(source)) child(Reflect.get(source, key), Reflect.get(target, key))
      }
      return link
    }
    // Acquire new roots before releasing old roots: most descendants are shared
    // with the previous checkpoint, so their watches survive without rebuilding.
    for (const { source, target } of values) {
      if (!container(source) || !container(target)) continue
      const root = visit(source, target)
      root.roots++; next.push(root)
      if (built.has(source)) metrics.indexedRoots++
    }
    for (const root of roots) { root.roots--; release(root) }
    roots = next
    metrics.indexMs += performance.now() - started
  }
  function phase(): ComparisonAcceleration | undefined {
    drain()
    if (!enabled || !coverage || roots.length === 0) return undefined
    const active = new Set<Link>(), activations: Link[] = [], blocked = new Map<Link, number>()
    function activate(link: Link) { if (!active.has(link)) { active.add(link); activations.push(link) } }
    function isActive(link: Link): boolean {
      if (active.has(link)) return true
      for (let index = 0; index < edgeCount(link.parents); index++) if (active.has(edgeAt(link.parents, index))) return true
      const pending: Link[] = [], seen = new Set<Link>()
      for (let index = 0; index < edgeCount(link.parents); index++) pending.push(edgeAt(link.parents, index))
      for (let index = 0; index < pending.length; index++) {
        const parent = pending[index]!
        if (seen.has(parent)) continue
        seen.add(parent)
        for (let position = 0; position < edgeCount(parent.parents); position++) {
          const ancestor = edgeAt(parent.parents, position)
          if (active.has(ancestor)) return true
          pending.push(ancestor)
        }
      }
      return false
    }
    function conflicts(source: object, target: object, difference: number) {
      const a = sourceLinks.get(source), b = targetLinks.get(target), seen = new Set<Link>()
      function block(link: Link) {
        if (seen.has(link)) return
        seen.add(link); blocked.set(link, (blocked.get(link) ?? 0) + difference)
        for (let index = 0; index < edgeCount(link.parents); index++) block(edgeAt(link.parents, index))
      }
      if (a !== undefined && a.target !== target) block(a)
      if (b !== undefined && b.source !== source) block(b)
    }
    function reusable(link: Link | undefined) {
      if (link === undefined || dirty(link) || (blocked.get(link) ?? 0) !== 0) return false
      activate(link); metrics.hits++; return true
    }
    return {
      baseTarget: target => targetLinks.get(target)?.source,
      mark: () => activations.length,
      rollback(mark) { for (let index = activations.length - 1; index >= mark; index--) active.delete(activations[index]!); activations.length = mark },
      match(source, target) {
        if (!container(source)) return false
        const link = sourceLinks.get(source)
        if (link?.target === target && reusable(link)) return true
        metrics.misses++; return false
      },
      get(source) { const link = sourceLinks.get(source); return link !== undefined && isActive(link) ? link.target : undefined },
      reverse(target) { const link = targetLinks.get(target); return link !== undefined && isActive(link) ? link.source : undefined },
      reuseSource(source) { const link = sourceLinks.get(source); return reusable(link) ? link!.target : undefined },
      reuseTarget(target) { const link = targetLinks.get(target); return reusable(link) ? link!.source : undefined },
      added(source, target) { conflicts(source, target, 1) },
      removed(source, target) { conflicts(source, target, -1) },
    }
  }
  return { touch, keep, phase, clear,
    configure(mode: 'full' | 'incremental') { enabled = mode === 'incremental'; if (!enabled) clear() },
    coverage(complete: boolean) { coverage = complete; if (!complete) clear() },
    stats: () => ({ ...metrics, enabled: enabled && coverage, coverage, roots: roots.length, pending: touched.size }),
  }
}
