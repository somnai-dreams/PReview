import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

type Cell = { id: string; kind: 'ref'; read: () => unknown }
type Probe = {
  register: (cell: Cell) => void
  audit: (candidates: { id: string; owner: Cell; value: unknown }[], retained: Set<string>, previous: Set<string>, warm: boolean) => void
  stats: () => { missed: number; missedRefs: number; lastMissed: string[] }
}
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(await Bun.file(new URL('./observer.ts', import.meta.url)).text())

test('the shadow audit distinguishes a missing checkpoint cell from an undetected ref mutation', () => {
  const probe = runInNewContext(code + ';globalThis.__previewFiberProbe', { performance, addEventListener() {} }) as Probe
  const value = { count: 1 }, cell: Cell = { id: 'ref', kind: 'ref', read: () => value }
  const candidates = [{ id: cell.id, owner: cell, value }]
  probe.register(cell)
  probe.audit(candidates, new Set(), new Set(), false)
  probe.audit(candidates, new Set(), new Set(), true)
  expect(probe.stats().missed).toBe(0)
  value.count++
  probe.audit(candidates, new Set(), new Set(['ref']), true)
  expect(probe.stats().missedRefs).toBe(1)
  expect(probe.stats().lastMissed).toEqual(['ref'])
})
