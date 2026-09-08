// Experimental adapter for the React 18.3 development renderer. Loaded before
// React. Existing DevTools callbacks are chained; application values stay local.
type Hook = { memoizedState: unknown; next: Hook | null }
type Fiber = { tag: number; child: Fiber | null; sibling: Fiber | null; memoizedState: Hook | null }
type Root = { current: Fiber }
type Renderer = { version: string; overrideHookState?: (fiber: Fiber, index: number, path: string[], value: unknown) => void }
type DevToolsHook = {
  supportsFiber: boolean; renderers: Map<number, Renderer>
  inject: (renderer: Renderer) => number
  onCommitFiberRoot?: (id: number, root: Root, ...rest: unknown[]) => void
  onCommitFiberUnmount?: (id: number, fiber: Fiber) => void
}
type Cell = { id: string; kind: 'state' | 'ref'; read: () => unknown }
type Registration = { value: unknown; dirty: boolean; fiber: Fiber | null; renderer: number; hook: number }
const registrations = new Map<Cell, Registration>()
const roots = new Map<number, Root>()
const metrics = { commits: 0, fibers: 0, hooks: 0, totalMs: 0, lastMs: 0, maxMs: 0, captures: 0, changed: 0, missed: 0, missedRefs: 0, changedReactValues: 0 }
let lastMissed: string[] = []

const target = globalThis as typeof globalThis & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook; __previewFiberProbe?: typeof probe }
const hook: DevToolsHook = target.__REACT_DEVTOOLS_GLOBAL_HOOK__ ?? {
  supportsFiber: true, renderers: new Map(),
  inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
}
target.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
const previousCommit = hook.onCommitFiberRoot
hook.onCommitFiberRoot = function (id, root, ...rest) {
  previousCommit?.call(hook, id, root, ...rest)
  roots.set(id, root)
  const started = performance.now()
  let fibers = 0, hooks = 0, changed = 0
  const pending = [root.current]
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const fiber = pending[cursor]!
    fibers++
    if (fiber.child !== null) pending.push(fiber.child)
    if (fiber.sibling !== null) pending.push(fiber.sibling)
    // FunctionComponent, ForwardRef, SimpleMemoComponent in React 18.3.
    if (fiber.tag !== 0 && fiber.tag !== 11 && fiber.tag !== 15) continue
    let index = 0
    for (let item = fiber.memoizedState; item !== null; item = item.next) {
      const value = item.memoizedState
      hooks++
      if (value !== null && typeof value === 'object' && 'current' in value) {
        const registration = registrations.get(value.current as Cell)
        if (registration !== undefined) {
          const cell = value.current as Cell
          registration.fiber = fiber; registration.renderer = id
          // These offsets describe PReview's own wrappers, not app hook order.
          registration.hook = index - (cell.kind === 'state' ? 2 : 4)
          const current = cell.read()
          if (!Object.is(registration.value, current)) {
            registration.dirty = true; registration.value = current; changed++
          }
        }
      }
      index++
    }
  }
  metrics.commits++; metrics.fibers = fibers; metrics.hooks = hooks
  metrics.changedReactValues += changed
  metrics.lastMs = performance.now() - started
  metrics.maxMs = Math.max(metrics.maxMs, metrics.lastMs)
  metrics.totalMs += metrics.lastMs
}

const probe = {
  register(cell: Cell) { registrations.set(cell, { value: cell.read(), dirty: true, fiber: null, renderer: 0, hook: -1 }) },
  remove(cell: Cell) { registrations.delete(cell) },
  audit(candidates: { id: string; owner: Cell; value: unknown }[], retained: Set<string>, previousIds: Set<string>, warm: boolean) {
    if (warm) metrics.captures++
    lastMissed = []
    for (const item of candidates) {
      const registration = registrations.get(item.owner)
      if (registration === undefined) continue
      // Cells absent from the peer checkpoint must be sent regardless of writes.
      const predicted = !previousIds.has(item.id) || registration.dirty || !Object.is(registration.value, item.value)
      if (warm && !retained.has(item.id)) {
        metrics.changed++
        if (!predicted) { metrics.missed++; lastMissed.push(item.id); if (item.owner.kind === 'ref') metrics.missedRefs++ }
      }
      registration.value = item.value; registration.dirty = false
    }
  },
  override(id: string, value: unknown) {
    const matches = [...registrations].filter(([cell]) => cell.id === id && cell.kind === 'state')
    if (matches.length !== 1) throw new Error('Expected one observed state cell')
    const [, registration] = matches[0]!
    const renderer = hook.renderers.get(registration.renderer)
    if (renderer?.version !== '18.3.1' || renderer.overrideHookState === undefined || registration.fiber === null || registration.hook < 0) throw new Error('Unsupported renderer or uncommitted state')
    renderer.overrideHookState(registration.fiber, registration.hook, [], value)
  },
  stats() { return { ...metrics, lastMissed, cells: registrations.size, mappedCells: [...registrations.values()].filter(item => item.fiber !== null).length, roots: roots.size, versions: [...hook.renderers.values()].map(renderer => renderer.version) } },
}
target.__previewFiberProbe = probe

// Readable, value-free diagnostics for the experiment, outside React's tree.
addEventListener('DOMContentLoaded', () => {
  const panel = document.createElement('details'), title = document.createElement('summary'), output = document.createElement('pre')
  panel.id = 'fiber-probe'; title.textContent = 'Fiber probe'
  panel.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:#fff;color:#111;padding:8px;border:1px solid #888;font:12px monospace;max-height:45vh;overflow:auto'
  panel.append(title, output); document.body.append(panel)
  const update = () => { output.textContent = JSON.stringify(probe.stats(), null, 2) }
  panel.addEventListener('toggle', update)
  setInterval(() => { if (panel.open) update() }, 1000)
})
