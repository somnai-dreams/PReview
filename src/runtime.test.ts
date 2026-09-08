import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { accepts, equal, comparison, checkpointValidation, reconcile, restoration, type Schema, type Value } from './values'
import { incrementalCache } from './incremental'
import { retainedCells, encodeValues, decodeValues } from './checkpoint'

const runtimeSource = (await Bun.file(new URL('./runtime.js', import.meta.url)).text())
  .replace(/^import .*$/gm, '').replaceAll('export function ', 'function ')

type Cell = { id: string; kind: 'ref' | 'state'; schema: Schema; read: () => Value; write: (next: Value) => void }
type Saved = { id: string; kind: Cell['kind']; value: Value }
type Packet = { id: string; base: string | null; values: (Saved | { id: string; kind: Cell['kind']; reuse: true })[]; references?: { marker: object; cell: number; path: unknown[] }[]; scroll: never[]; history: typeof journal }
type Report = { skipped: { id: string; reason: string; count: number }[]; rejectionDetails: { id: string; reason: string; phase: string; count?: number }[]; timing: { decodeMs: number; validationMs: number; restoreMs: number }; restored: string[]; rejected: string[]; absent: string[]; secondPass?: string[]; changed?: string[]; retained?: number; transferred?: number; needsFull?: boolean }
type Runtime = { register: (cell: Cell) => void; duplicate: (cell: Cell) => void; remove: (id: string) => void; mountRef: (id: string, schema: Schema, initial: Value) => { current: Value }; mountState: (id: string, schema: Schema, initial: Value) => [Value, unknown]; restore: (snapshot: Packet) => Report; capture: () => Packet; full: () => Packet }
const journal = { entries: [{ state: { route: '/' }, path: '/' }], index: 0 }
const data: Schema = { root: 0, nodes: [{ kind: 'data' }] }

function harness(afterCommit: (pass: number) => void = () => {}, allowCapture = false, incremental?: ReturnType<typeof incrementalCache>) {
  let commits = 0, clones = 0
  const runtime = runInNewContext(runtimeSource + '\n;({restore,capture,full:()=>({...checkpoint.snapshot,id:checkpoint.id,base:null,references:[]}),register:cell=>cells.set(cell.id,[cell]),duplicate:cell=>cells.get(cell.id).push(cell),remove:id=>cells.delete(id),mountRef:useObservedRef,mountState:useObservedState})', {
    __previewIncremental: incremental, accepts, equal, comparison, checkpointValidation, reconcile, restoration, retainedCells, encodeValues, decodeValues, crypto,
    history: { state: { route: '/' }, replaceState() {} },
    location: { pathname: '/', search: '', hash: '', origin: 'https://localhost:4511', href: 'https://localhost:4511/' },
    addEventListener() {}, performance, URL, DOMException,
    structuredClone(value: unknown) { clones++; return structuredClone(value) },
    document: { querySelectorAll() { if (!allowCapture) throw new Error('Restoration must not capture the destination'); return [] } },
    useRef: (current: Value) => ({ current }),
    useState: (initial: Value | (() => Value)) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useLayoutEffect: (effect: () => void) => effect(),
    flushSync(callback: () => void) { callback(); afterCommit(++commits) },
  }) as Runtime
  return { runtime, counts: () => ({ commits, clones }) }
}

function cell(id: string, kind: Cell['kind'], initial: Value) {
  let value = initial, writes = 0
  return {
    cell: { id, kind, schema: data, read: () => value, write(next: Value) { writes++; value = next } },
    reset(next: Value) { value = next },
    writes: () => writes,
  }
}

test('restore repairs reset and newly mounted cells without rewriting settled cells or capturing destination data', () => {
  const stable = cell('feed', 'ref', new Map([['one', { title: 'old' }]]))
  const draft = cell('draft', 'state', '')
  const child = cell('child', 'state', '')
  const { runtime, counts } = harness(pass => {
    if (pass === 1) { draft.reset('mount reset'); runtime.register(child.cell) }
  })
  runtime.register(stable.cell)
  runtime.register(draft.cell)
  const report = runtime.restore({ id: crypto.randomUUID(), base: null, history: journal, scroll: [], values: [
    { id: 'feed', kind: 'ref', value: new Map([['one', { title: 'saved' }]]) },
    { id: 'draft', kind: 'state', value: 'saved draft' },
    { id: 'child', kind: 'state', value: 'saved child' },
  ] })
  expect(stable.writes()).toBe(1)
  expect(draft.writes()).toBe(2)
  expect(child.writes()).toBe(1)
  expect(draft.cell.read()).toBe('saved draft')
  expect(child.cell.read()).toBe('saved child')
  expect(report.secondPass).toEqual(['draft', 'child'])
  expect(report.changed).toEqual([])
  expect(report.absent).toEqual([])
  expect(report).not.toHaveProperty('current')
  expect(counts()).toEqual({ commits: 2, clones: 1 }) // Only the small history journal is cloned.
})

test('repair retains aliases to refs that do not need a second write', () => {
  const feed = cell('feed', 'ref', new Map([['one', { title: 'old' }]]))
  const selected = cell('selected', 'state', null)
  const { runtime } = harness(pass => { if (pass === 1) selected.reset({ title: 'saved' }) })
  runtime.register(feed.cell)
  runtime.register(selected.cell)
  const row = { title: 'saved' }
  const report = runtime.restore({ id: crypto.randomUUID(), base: null, history: journal, scroll: [], values: [
    { id: 'feed', kind: 'ref', value: new Map([['one', row]]) },
    { id: 'selected', kind: 'state', value: row },
  ] })
  expect(report.secondPass).toEqual(['selected'])
  expect(feed.writes()).toBe(1)
  expect(selected.cell.read()).toBe((feed.cell.read() as Map<string, Value>).get('one'))
  expect(report.changed).toEqual([])
})

test('a settled restoration needs one commit and an incompatible value needs none', () => {
  const draft = cell('draft', 'state', '')
  const { runtime, counts } = harness()
  runtime.register(draft.cell)
  const first = runtime.restore({ id: crypto.randomUUID(), base: null, history: journal, scroll: [], values: [{ id: 'draft', kind: 'state', value: 'saved' }] })
  expect(first.secondPass).toEqual([])
  expect(counts()).toEqual({ commits: 1, clones: 1 })
  draft.cell.schema = { root: 0, nodes: [{ kind: 'primitive', name: 'number' }] }
  const rejected = runtime.restore({ id: crypto.randomUUID(), base: null, history: journal, scroll: [], values: [{ id: 'draft', kind: 'state', value: 'incompatible' }] })
  expect(rejected.rejected).toEqual(['draft'])
  expect(rejected).not.toHaveProperty('current')
  expect(draft.writes()).toBe(1)
  expect(counts()).toEqual({ commits: 1, clones: 1 })
})

test('warm round trips send a changed draft without copying or writing the unchanged feed', () => {
  const a = harness(undefined, true), b = harness(undefined, true)
  const aFeed = cell('feed', 'ref', new Map([['one', { title: 'saved' }]])), bFeed = cell('feed', 'ref', new Map())
  const aDraft = cell('draft', 'state', 'first'), bDraft = cell('draft', 'state', '')
  for (const item of [aFeed, aDraft]) a.runtime.register(item.cell)
  for (const item of [bFeed, bDraft]) b.runtime.register(item.cell)
  expect(b.runtime.restore(a.runtime.capture()).transferred).toBe(2)
  bDraft.reset('typed in B')
  const delta = b.runtime.capture()
  expect(delta.values.find(saved => saved.id === 'feed')).toEqual({ id: 'feed', kind: 'ref', reuse: true })
  const report = a.runtime.restore(structuredClone(delta))
  expect(report.retained).toBe(1)
  expect(report.transferred).toBe(1)
  expect(aFeed.writes()).toBe(0)
  expect(aDraft.cell.read()).toBe('typed in B')
  expect(b.runtime.restore(structuredClone(a.runtime.capture())).retained).toBe(2)
  expect(bFeed.writes()).toBe(1)
  expect(bDraft.writes()).toBe(1)
})

test('warm restore repairs hidden destination drift and rejects resources before writing', () => {
  const a = harness(undefined, true), b = harness(undefined, true)
  const aFeed = cell('feed', 'ref', { count: 1 }), bFeed = cell('feed', 'ref', { count: 0 })
  a.runtime.register(aFeed.cell); b.runtime.register(bFeed.cell)
  b.runtime.restore(a.runtime.capture())
  aFeed.reset({ count: 99 })
  expect(a.runtime.restore(b.runtime.capture()).retained).toBe(0)
  expect(aFeed.cell.read()).toEqual({ count: 1 })
  b.runtime.restore(a.runtime.capture())
  aFeed.reset(new AbortController() as unknown as Value)
  expect(a.runtime.restore(b.runtime.capture()).rejected).toEqual(['feed'])
  expect(aFeed.writes()).toBe(1)
})

test('changed shared refs transfer together and a third build requests the complete checkpoint', () => {
  const a = harness(undefined, true), b = harness(undefined, true), c = harness(undefined, true)
  const row = { title: 'saved' }
  const aFeed = cell('feed', 'ref', new Map([['one', row]])), aSelected = cell('selected', 'state', row)
  a.runtime.register(aFeed.cell); a.runtime.register(aSelected.cell)
  const bFeed = cell('feed', 'ref', new Map()), bSelected = cell('selected', 'state', null)
  b.runtime.register(bFeed.cell); b.runtime.register(bSelected.cell)
  b.runtime.restore(a.runtime.capture())
  ;(bSelected.cell.read() as typeof row).title = 'mutated without render'
  const delta = b.runtime.capture()
  expect(delta.values.every(saved => !('reuse' in saved))).toBe(true)
  expect(a.runtime.restore(delta).transferred).toBe(2)
  expect(aSelected.cell.read()).toBe((aFeed.cell.read() as Map<string, Value>).get('one'))
  const cFeed = cell('feed', 'ref', new Map()), cSelected = cell('selected', 'state', null)
  c.runtime.register(cFeed.cell); c.runtime.register(cSelected.cell)
  expect(c.runtime.restore(a.runtime.capture()).needsFull).toBe(true)
  expect(cFeed.writes()).toBe(0)
  expect(c.runtime.restore(a.runtime.full()).transferred).toBe(2)
  expect(cSelected.cell.read()).toEqual({ title: 'mutated without render' })
  expect(cSelected.cell.read()).toBe((cFeed.cell.read() as Map<string, Value>).get('one'))
})

test('a newly mounted alias uses the retained graph through an actual cloned message', () => {
  const a = harness(undefined, true), b = harness(undefined, true)
  const aFeed = cell('feed', 'ref', [{ title: 'saved' }]), bFeed = cell('feed', 'ref', [])
  a.runtime.register(aFeed.cell); b.runtime.register(bFeed.cell)
  b.runtime.restore(structuredClone(a.runtime.capture()))
  const aSelected = cell('selected', 'ref', null), bSelected = cell('selected', 'ref', (bFeed.cell.read() as Value[])[0])
  a.runtime.register(aSelected.cell); b.runtime.register(bSelected.cell)
  const delta = b.runtime.capture()
  expect(delta.references).toHaveLength(1)
  expect(delta.values.find(saved => saved.id === 'feed')).toHaveProperty('reuse', true)
  const report = a.runtime.restore(structuredClone(delta))
  expect(report.retained).toBe(1)
  expect(aFeed.writes()).toBe(0)
  expect(aSelected.cell.read()).toBe((aFeed.cell.read() as Value[])[0])
  ;(aSelected.cell.read() as { title: string }).title = 'continued edit'
  expect((aFeed.cell.read() as { title: string }[])[0]!.title).toBe('continued edit')
})

test('warmed checkpoint validation cannot hide an invalid in-place live ref edit', () => {
  const a = harness(undefined, true), b = harness(undefined, true)
  const aFeed = cell('feed', 'ref', { count: 1 }), bFeed = cell('feed', 'ref', { count: 0 })
  const schema: Schema = { root: 0, nodes: [
    { kind: 'object', fields: [{ name: 'count', optional: false, shape: 1 }], index: null },
    { kind: 'primitive', name: 'number' },
  ] }
  aFeed.cell.schema = schema; bFeed.cell.schema = schema
  a.runtime.register(aFeed.cell); b.runtime.register(bFeed.cell)
  b.runtime.restore(structuredClone(a.runtime.capture()))
  a.runtime.restore(structuredClone(b.runtime.capture()))
  const current = aFeed.cell.read() as { count: Value }
  current.count = 'invalid'
  expect(a.runtime.capture().values).toEqual([])
  expect(a.runtime.restore(structuredClone(b.runtime.full())).rejected).toEqual(['feed'])
})

test('each commit invalidates comparisons of previously retained live data', () => {
  let mutate = false
  const aFeed = cell('feed', 'ref', { count: 1 }), aDraft = cell('draft', 'state', 'initial')
  const a = harness(() => { if (mutate) (aFeed.cell.read() as { count: number }).count++ }, true)
  const b = harness(undefined, true)
  const bFeed = cell('feed', 'ref', { count: 0 }), bDraft = cell('draft', 'state', '')
  a.runtime.register(aFeed.cell); a.runtime.register(aDraft.cell)
  b.runtime.register(bFeed.cell); b.runtime.register(bDraft.cell)
  b.runtime.restore(structuredClone(a.runtime.capture()))
  bDraft.reset('edited')
  mutate = true
  const report = a.runtime.restore(structuredClone(b.runtime.capture()))
  expect(report.retained).toBe(1)
  expect(report.secondPass).toEqual(['feed'])
  expect(report.changed).toEqual(['feed'])
  expect(aFeed.writes()).toBe(1)
  expect(aDraft.cell.read()).toBe('edited')
})

test('verification does not rescan a settled graph when no repair commit occurred', () => {
  let reads = 0
  const observed = new Proxy({ count: 1 }, { ownKeys(target) { reads++; return Reflect.ownKeys(target) } })
  const feed = cell('feed', 'ref', observed)
  const { runtime } = harness(() => { reads = 0 })
  runtime.register(feed.cell)
  const report = runtime.restore({ id: crypto.randomUUID(), base: null, history: journal, scroll: [], values: [
    { id: 'feed', kind: 'ref', value: { count: 2 } },
  ] })
  expect(report.secondPass).toEqual([])
  expect(report.changed).toEqual([])
  expect(reads).toBe(1)
})


test('incremental warm round trips retain feed proofs, transfer edits and repair observed hidden drift', () => {
  const aCache = incrementalCache(), bCache = incrementalCache()
  const a = harness(undefined, true, aCache), b = harness(undefined, true, bCache)
  const original = { count: 1 }, aFeed = cell('feed', 'ref', [original]), bFeed = cell('feed', 'ref', [])
  const aDraft = cell('draft', 'state', 'first'), bDraft = cell('draft', 'state', '')
  for (const entry of [aFeed, aDraft]) a.runtime.register(entry.cell)
  for (const entry of [bFeed, bDraft]) b.runtime.register(entry.cell)
  b.runtime.restore(structuredClone(a.runtime.capture()))
  const indexed = aCache.stats().indexedRoots
  bDraft.reset('changed')
  const report = a.runtime.restore(structuredClone(b.runtime.capture()))
  expect(report.retained).toBe(1)
  expect(report.changed).toEqual([])
  expect(aFeed.writes()).toBe(0)
  expect(aDraft.cell.read()).toBe('changed')
  expect(aCache.stats().indexedRoots).toBe(indexed)
  expect(aCache.stats().hits).toBeGreaterThan(0)
  aCache.touch(original, 'property', 'count').count = 3
  expect(a.runtime.restore(structuredClone(b.runtime.capture())).retained).toBe(1) // The draft stayed unchanged.
  expect(aFeed.cell.read()).toEqual([{ count: 1 }])
})

test('incremental repair observes effect writes after each commit and retains alias identity', () => {
  const aCache = incrementalCache(), bCache = incrementalCache()
  const aFeed = cell('feed', 'ref', { count: 1 }), aDraft = cell('draft', 'state', 'first')
  let mutate = false
  const a = harness(() => { if (mutate) aCache.touch(aFeed.cell.read() as {count:number}, 'property', 'count').count++ }, true, aCache)
  const b = harness(undefined, true, bCache), bFeed = cell('feed', 'ref', { count: 0 }), bDraft = cell('draft', 'state', '')
  a.runtime.register(aFeed.cell); a.runtime.register(aDraft.cell)
  b.runtime.register(bFeed.cell); b.runtime.register(bDraft.cell)
  b.runtime.restore(structuredClone(a.runtime.capture()))
  bDraft.reset('edited'); mutate = true
  const report = a.runtime.restore(structuredClone(b.runtime.capture()))
  expect(report.retained).toBe(1)
  expect(report.secondPass).toEqual(['feed'])
  expect(report.changed).toEqual(['feed'])
})


test('ambiguous destination owners stay local through remounts without blocking a draft or poisoning the next capture', () => {
  const draft = cell('draft', 'state', ''), drag = cell('drag', 'ref', false), otherDrag = cell('drag', 'ref', false)
  const mode = cell('mode', 'state', 'local'), otherMode = cell('mode', 'state', 'other local')
  let remounted: { current: Value } | undefined, remountedState: { value: Value } = { value: null }
  const { runtime } = harness(pass => {
    if (pass !== 1) return
    runtime.remove('drag'); runtime.remove('mode')
    remounted = runtime.mountRef('drag', data, false)
    ;[remountedState.value] = runtime.mountState('mode', data, 'new local')
  }, true)
  for (const entry of [draft, drag, mode]) runtime.register(entry.cell)
  runtime.duplicate(otherDrag.cell); runtime.duplicate(otherMode.cell)
  const report = runtime.restore({ id: crypto.randomUUID(), base: null, history: journal, scroll: [], values: [
    { id: 'draft', kind: 'state', value: 'keep my draft' },
    { id: 'drag', kind: 'ref', value: true },
    { id: 'mode', kind: 'state', value: 'incoming mode' },
  ] })
  expect(draft.cell.read()).toBe('keep my draft')
  expect(report.rejected).toEqual([])
  expect(report.restored).toEqual(['draft'])
  expect(report.skipped).toEqual([
    { id: 'drag', reason: 'multiple instances', count: 2 },
    { id: 'mode', reason: 'multiple instances', count: 2 },
  ])
  expect([drag.writes(), otherDrag.writes(), mode.writes(), otherMode.writes()]).toEqual([0, 0, 0, 0])
  expect(remounted!.current).toBe(false)
  expect(remountedState.value).toBe('new local')
  expect(report.changed).toEqual([])
  expect(runtime.capture().values.find(saved => saved.id === 'drag')).toEqual({ id: 'drag', kind: 'ref', value: false })
})

test('rejections distinguish hook kind, incoming shape and live resources before writing any accepted cell', () => {
  const draft = cell('draft', 'state', 'local'), count = cell('count', 'state', 0)
  count.cell.schema = { root: 0, nodes: [{ kind: 'primitive', name: 'number' }] }
  const resource = cell('resource', 'ref', new AbortController() as unknown as Value)
  const wrongKind = cell('kind', 'ref', false)
  const { runtime, counts } = harness()
  for (const entry of [draft, count, resource, wrongKind]) runtime.register(entry.cell)
  const report = runtime.restore({ id: crypto.randomUUID(), base: null, history: journal, scroll: [], values: [
    { id: 'draft', kind: 'state', value: 'incoming' },
    { id: 'count', kind: 'state', value: 'not a number' },
    { id: 'resource', kind: 'ref', value: {} },
    { id: 'kind', kind: 'state', value: false },
  ] })
  expect(report.restored).toEqual([])
  expect(report.rejectionDetails).toEqual([
    { id: 'count', reason: 'incoming-value-invalid', phase: 'validation' },
    { id: 'resource', reason: 'live-ref-invalid', phase: 'validation' },
    { id: 'kind', reason: 'hook-kind-mismatch', phase: 'validation' },
  ])
  expect(report.timing.decodeMs).toBeGreaterThanOrEqual(0)
  expect(report.timing.validationMs).toBeGreaterThanOrEqual(0)
  expect(report.timing.restoreMs).toBeGreaterThanOrEqual(report.timing.validationMs)
  expect(draft.cell.read()).toBe('local')
  expect(counts().commits).toBe(0)
})

test('new ambiguity after either commit is reported as a failed restore rather than claimed untouched', () => {
  for (const ambiguousPass of [1, 2]) {
    const draft = cell('draft', 'state', ''), extra = cell('draft', 'state', 'local')
    const { runtime } = harness(pass => {
      if (pass === ambiguousPass) runtime.duplicate(extra.cell)
      else draft.reset('effect reset')
    })
    runtime.register(draft.cell)
    const report = runtime.restore({ id: crypto.randomUUID(), base: null, history: journal, scroll: [], values: [
      { id: 'draft', kind: 'state', value: 'incoming' },
    ] })
    expect(report.rejectionDetails).toEqual([{ id: 'draft', reason: 'multiple-instances-after-commit', count: 2, phase: ambiguousPass === 1 ? 'repair' : 'verification' }])
    expect(report.skipped).toEqual([])
    expect(extra.writes()).toBe(0)
  }
})
