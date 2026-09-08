import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

type Cell = { id: string; owner: object; value: unknown }
type Probe = {
  touch: (value: unknown) => unknown
  audit: (candidates: Cell[], accepted: Cell[], retained: Set<string>, previousIds: Set<string>, warm: boolean, comparisonMs: number) => void
  restored: (candidates: Cell[], changed: Set<string>) => void
  stats: () => { missed: number; lastMissed: string[]; watchedObjects: number; reindexes: number }
}
const built = await Bun.build({ entrypoints: [import.meta.dir + '/observer.ts'], target: 'browser', format: 'iife' })
if (!built.success) throw new AggregateError(built.logs, 'Observer test build failed')
const code = await built.outputs[0]!.text()
function observer() { return runInNewContext(code + ';globalThis.__previewWrites', { performance, addEventListener() {} }) as Probe }

test('shadow comparison includes a formerly accepted value made invalid by an unobserved write', () => {
  const probe = observer(), value: { count: number; invalid?: () => void } = { count: 0 }
  const cells = [{ id: 'ref', owner: {}, value }]
  probe.audit(cells, cells, new Set(), new Set(), false, 0)
  value.invalid = () => {}
  probe.audit(cells, [], new Set(), new Set(['ref']), true, 0)
  expect(probe.stats().lastMissed).toEqual(['ref'])
  expect(probe.stats().watchedObjects).toBe(0)
})

test('restore rebases observation to the receiving checkpoint and leaves mismatched values unindexed', () => {
  const probe = observer(), value = { count: 0 }, cells = [{ id: 'ref', owner: {}, value }]
  probe.restored(cells, new Set())
  value.count++
  probe.touch(value)
  probe.audit(cells, cells, new Set(), new Set(['ref']), true, 0)
  expect(probe.stats().missed).toBe(0)
  const bad = [{ ...cells[0]!, value: { get invalid() { throw new Error('Must not evaluate an accessor') } } }]
  probe.restored(bad, new Set(['ref']))
  expect(probe.stats().watchedObjects).toBe(0)
})

test('a verified restore keeps the clean membership index and rebuilds after an observed write', () => {
  const probe = observer(), value = { count: 0 }, cells = [{ id: 'ref', owner: {}, value }]
  probe.restored(cells, new Set())
  const first = probe.stats().reindexes
  probe.restored(cells, new Set())
  expect(probe.stats().reindexes).toBe(first)
  probe.touch(value); value.count++
  probe.restored(cells, new Set())
  expect(probe.stats().reindexes).toBe(first + 1)
})
