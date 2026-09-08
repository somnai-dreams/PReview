import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { accepts, equal, comparison, checkpointValidation, reconcile, restoration, type Schema, type Value } from './values'
import { retainedCells, encodeValues, decodeValues } from './checkpoint'

const runtimeSource = (await Bun.file(new URL('./runtime.js', import.meta.url)).text())
  .replace(/^import .*$/gm, '').replaceAll('export function ', 'function ')

type Cell = { id: string; kind: 'ref' | 'state'; schema: Schema; read: () => Value; write: (next: Value) => void }
type Saved = { id: string; kind: Cell['kind']; value: Value }
type Packet = { id: string; base: string | null; values: (Saved | { id: string; kind: Cell['kind']; reuse: true })[]; references?: { marker: object; cell: number; path: unknown[] }[]; scroll: never[]; history: typeof journal }
type Report = { restored: string[]; rejected: string[]; absent: string[]; secondPass?: string[]; changed?: string[]; retained?: number; transferred?: number; needsFull?: boolean }
type Runtime = { register: (cell: Cell) => void; restore: (snapshot: Packet) => Report; capture: () => Packet; full: () => Packet }
const journal = { entries: [{ state: { route: '/' }, path: '/' }], index: 0 }
const data: Schema = { root: 0, nodes: [{ kind: 'data' }] }

function harness(afterCommit: (pass: number) => void = () => {}, allowCapture = false) {
  let commits = 0, clones = 0
  const runtime = runInNewContext(runtimeSource + '\n;({restore,capture,full:()=>({...checkpoint.snapshot,id:checkpoint.id,base:null,references:[]}),register:cell=>cells.set(cell.id,[cell])})', {
    accepts, equal, comparison, checkpointValidation, reconcile, restoration, retainedCells, encodeValues, decodeValues, crypto,
    history: { state: { route: '/' }, replaceState() {} },
    location: { pathname: '/', search: '', hash: '', origin: 'https://localhost:4511', href: 'https://localhost:4511/' },
    addEventListener() {}, performance, URL, DOMException,
    structuredClone(value: unknown) { clones++; return structuredClone(value) },
    document: { querySelectorAll() { if (!allowCapture) throw new Error('Restoration must not capture the destination'); return [] } },
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
