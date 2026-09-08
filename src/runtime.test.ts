import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { accepts, equal, matchesRestoration, reconcile, restoration, type Schema, type Value } from './values'

const runtimeSource = (await Bun.file(new URL('./runtime.js', import.meta.url)).text())
  .replace(/^import .*$/gm, '').replaceAll('export function ', 'function ')

type Cell = { id: string; kind: 'ref' | 'state'; schema: Schema; read: () => Value; write: (next: Value) => void }
type Saved = { id: string; kind: Cell['kind']; value: Value }
type Report = { restored: string[]; rejected: string[]; absent: string[]; secondPass?: string[]; changed?: string[] }
type Runtime = { register: (cell: Cell) => void; restore: (snapshot: { values: Saved[]; scroll: never[]; history: typeof journal }) => Report }
const journal = { entries: [{ state: { route: '/' }, path: '/' }], index: 0 }
const data: Schema = { root: 0, nodes: [{ kind: 'data' }] }

function harness(afterCommit: (pass: number) => void = () => {}) {
  let commits = 0, clones = 0
  const runtime = runInNewContext(runtimeSource + '\n;({restore,register:cell=>cells.set(cell.id,[cell])})', {
    accepts, equal, matchesRestoration, reconcile, restoration,
    history: { state: { route: '/' }, replaceState() {} },
    location: { pathname: '/', search: '', hash: '', origin: 'https://localhost:4511', href: 'https://localhost:4511/' },
    addEventListener() {}, performance, URL, DOMException,
    structuredClone(value: unknown) { clones++; return structuredClone(value) },
    document: { querySelectorAll() { throw new Error('Restoration must not capture the destination') } },
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
  const report = runtime.restore({ history: journal, scroll: [], values: [
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
  const report = runtime.restore({ history: journal, scroll: [], values: [
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
  const first = runtime.restore({ history: journal, scroll: [], values: [{ id: 'draft', kind: 'state', value: 'saved' }] })
  expect(first.secondPass).toEqual([])
  expect(counts()).toEqual({ commits: 1, clones: 1 })
  draft.cell.schema = { root: 0, nodes: [{ kind: 'primitive', name: 'number' }] }
  const rejected = runtime.restore({ history: journal, scroll: [], values: [{ id: 'draft', kind: 'state', value: 'incompatible' }] })
  expect(rejected.rejected).toEqual(['draft'])
  expect(rejected).not.toHaveProperty('current')
  expect(draft.writes()).toBe(1)
  expect(counts()).toEqual({ commits: 1, clones: 1 })
})
