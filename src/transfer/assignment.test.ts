import { expect, test } from 'bun:test'
import { instrumentWrites } from '../write-compiler'
import { liveProofs } from './live-proofs'
import { data } from './validate'
import { repairJournal } from './repair-journal'
import { nativeWriter } from './raw-transfer'

test('reassigning unchanged library flags preserves all proofs without recording or revisiting rows', () => {
  const graph = liveProofs(0), rows = Array.from({length: 10000}, (_, n) => ({n, filtered: true})), root = {rows, selected: rows.at(-1)!}
  expect(graph.accepts(data, root)).toBe(true)
  const source = 'return rows => { for (const row of rows) row.filtered = true }'
  const transformed = instrumentWrites('fixture.ts', source)
  const run = new Function('globalThis', transformed.code)({__previewWrites: graph}) as (rows: typeof root.rows) => void
  const journal = repairJournal(graph, [{schema: data, value: root}], nativeWriter()), version = graph.version(root), reads = graph.stats().reads
  try {
    run(rows)
    expect(journal.objects()).toBe(0); expect(graph.dirty.size).toBe(0); expect(graph.version(root)).toBe(version)
    expect(graph.accepts(data, root)).toBe(true); expect(graph.stats().reads).toBe(reads)
    const selected = root.selected
    selected.filtered = graph.assignment(selected, 'filtered', false)
    expect(journal.objects()).toBe(1); expect(graph.dirty.size).toBe(1); expect(graph.version(root)).not.toBe(version)
    expect(journal.repair().ok).toBe(true); expect(selected.filtered).toBe(true); expect(root.selected).toBe(rows.at(-1)!)
  } finally { journal.close() }
})

test('property creation, signed zero and invalid values still invalidate a previously accepted graph', () => {
  const graph = liveProofs(0), value: { n: number; extra?: undefined } = {n: 0}
  expect(graph.accepts(data, value)).toBe(true)
  value.extra = graph.assignment(value, 'extra', undefined)
  expect(graph.dirty.size).toBe(1); expect(Object.hasOwn(value, 'extra')).toBe(true)
  graph.dirty.clear(); expect(graph.accepts(data, value)).toBe(true)
  value.n = graph.assignment(value, 'n', -0)
  expect(graph.dirty.size).toBe(1); expect(Object.is(value.n, -0)).toBe(true)
  expect(graph.accepts(data, value)).toBe(true)
  value.n = graph.assignment(value, 'n', NaN)
  expect(graph.accepts(data, value)).toBe(false)
})
