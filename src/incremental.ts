import type { ComparisonAcceleration, Construction } from './values'

type Link = { generation: number; pass: number; source: object; target: object; parents: Edges; children: Edges; roots: number; different: boolean; dirtyChildren: number; differences: Set<PropertyKey> | undefined; fields: Set<PropertyKey> | null | undefined }
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
  let roots: Link[] = [], enabled = true, coverage = true, generation = 0
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
      // Replaced correspondences stay invalid until their old roots release
      // them. A pending same-value write cannot revive obsolete alias ownership.
      if (sourceLinks.get(link.source) !== link || targetLinks.get(link.target) !== link) continue
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
  // Construction owns only the unattached roots of new correspondences. Children
  // move under their parents as they are completed; there is no second full map.
  function begin(): Construction | undefined {
    drain()
    if (!enabled || !coverage) return undefined
    const id = ++generation, staged = new Set<Link>(), previous = new WeakMap<object, object>()
    let closed = false
    function pin(link: Link) { if (!staged.has(link)) { staged.add(link); link.roots++ } }
    function unpin(link: Link) { if (staged.delete(link)) link.roots-- }
    function invalidate(link: Link) {
      const before = dirty(link)
      link.different = true
      if (!before) changed(link, 1)
    }
    function start(source: object, target: object, pass: number) {
      if (closed) throw new Error('Checkpoint construction is closed')
      const prior = sourceLinks.get(source), owner = targetLinks.get(target)
      if (prior?.generation === id) {
        if (prior.target !== target) throw new Error('Conflicting checkpoint aliases')
        prior.pass = pass; invalidate(prior); return
      }
      if (owner?.generation === id && owner.source !== source) throw new Error('Conflicting checkpoint identities')
      if (prior !== undefined) invalidate(prior)
      if (owner !== undefined) { previous.set(source, owner.source); invalidate(owner) }
      const link: Link = { generation: id, pass, source, target, parents: undefined, children: undefined, roots: 0, different: true, dirtyChildren: 0, differences: undefined, fields: undefined }
      sourceLinks.set(source, link); targetLinks.set(target, link)
      pin(link); metrics.indexedObjects++
    }
    function finish(source: object) {
      const link = sourceLinks.get(source)
      if (link?.generation !== id) throw new Error('Missing checkpoint construction')
      const oldChildren = link.children, wasDirty = dirty(link)
      link.children = undefined; link.dirtyChildren = 0
      function child(a: unknown, b: unknown) {
        if (!container(a)) return
        const entry = sourceLinks.get(a)
        if (entry === undefined || entry.target !== b) throw new Error('Missing checkpoint child correspondence')
        link!.children = appendEdge(link!.children, entry); entry.parents = appendEdge(entry.parents, link!)
        if (dirty(entry)) link!.dirtyChildren++
        unpin(entry)
      }
      const a = source, b = link.target
      if (a instanceof Map && b instanceof Map) {
        const other = b.entries()
        for (const [key, value] of a) { const row = other.next().value!; child(key, row[0]); child(value, row[1]) }
      } else if (a instanceof Set && b instanceof Set) {
        const other = b.values()
        for (const value of a) child(value, other.next().value)
      } else for (const key of Object.keys(a)) child(Reflect.get(a, key), Reflect.get(b, key))
      // Acquire children first. Detached copies stay canonical until this
      // transfer ends, including when effects replace an outer ref during repair.
      for (let index = 0; index < edgeCount(oldChildren); index++) {
        const child = edgeAt(oldChildren, index)
        child.parents = removeEdge(child.parents, link)
        if (child.parents === undefined && child.roots === 0) pin(child)
      }
      touched.delete(link); link.fields = undefined; link.differences = undefined; link.different = false
      if (wasDirty !== dirty(link)) changed(link, dirty(link) ? 1 : -1)
    }
    // Used only for a correspondence already established by a full comparison.
    // Controlled copying/reconciliation calls start/finish itself, bottom-up.
    function adopt(source: unknown, target: unknown): Link | undefined {
      if (!container(source) || !container(target)) return undefined
      const prior = sourceLinks.get(source)
      if (prior !== undefined && prior.target === target && !dirty(prior)) return prior
      start(source, target, 0)
      if (source instanceof Map && target instanceof Map) {
        const other = target.entries()
        for (const [key, value] of source) { const row = other.next().value!; adopt(key, row[0]); adopt(value, row[1]) }
      } else if (source instanceof Set && target instanceof Set) {
        const other = target.values()
        for (const value of source) adopt(value, other.next().value)
      } else for (const key of Object.keys(source)) adopt(Reflect.get(source, key), Reflect.get(target, key))
      finish(source)
      return sourceLinks.get(source)!
    }
    function close() {
      if (closed) return
      closed = true
      for (const link of staged) { link.roots--; release(link) }
      staged.clear()
    }
    return {
      start, finish, adopt, close,
      get(source) { const link = sourceLinks.get(source); return link?.generation === id ? { value: link.target, pass: link.pass } : undefined },
      source(target) { const link = targetLinks.get(target); return link?.generation === id ? link.source : undefined },
      previous: source => previous.get(source),
      commit(values) {
        drain()
        const next: Link[] = []
        for (const { source, target } of values) { const root = adopt(source, target); if (root !== undefined) { root.roots++; next.push(root); if (root.generation === id) metrics.indexedRoots++ } }
        for (const root of roots) { root.roots--; release(root) }
        roots = next
        close()
        if (!enabled || !coverage) clear()
      },
    }
  }
  function keep(values: { source: unknown; target: unknown }[]) {
    const started = performance.now(), construction = begin()
    if (construction === undefined) { clear(); return }
    try { construction.commit(values) } finally { construction.close() }
    metrics.indexMs += performance.now() - started
  }
  function phase(): ComparisonAcceleration | undefined {
    drain()
    if (!enabled || !coverage || metrics.indexedObjects === 0) return undefined
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
      if (link === undefined || sourceLinks.get(link.source) !== link || targetLinks.get(link.target) !== link || dirty(link) || (blocked.get(link) ?? 0) !== 0) return false
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
  // Checkpoint encoding needs paths through owned source data. Its existing
  // parent links identify the only subtrees that can contain those references;
  // live-object dirtiness does not change these immutable source edges.
  function ancestors(sources: Iterable<object>): Set<object> | undefined {
    // A widely shared object can have more ancestors than a forward search
    // would visit. Bound this optional work before falling back to that search.
    const limit = 4096
    const pending: Link[] = [], seen = new Set<Link>(), values = new Set<object>()
    for (const source of sources) {
      const link = sourceLinks.get(source)
      if (link === undefined) return undefined
      pending.push(link)
      if (pending.length > limit) return undefined
    }
    for (let index = 0; index < pending.length; index++) {
      const link = pending[index]!
      if (seen.has(link)) continue
      seen.add(link); values.add(link.source)
      if (pending.length + edgeCount(link.parents) > limit) return undefined
      for (let parent = 0; parent < edgeCount(link.parents); parent++) pending.push(edgeAt(link.parents, parent))
    }
    return values
  }
  return { touch, begin, keep, phase, clear, ancestors,
    configure(mode: 'full' | 'incremental') { enabled = mode === 'incremental'; if (!enabled) clear() },
    coverage(complete: boolean) { coverage = complete; if (!complete) clear() },
    stats: () => ({ ...metrics, enabled: enabled && coverage, coverage, roots: roots.length, pending: touched.size }),
  }
}
