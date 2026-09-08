import { expect, test } from 'bun:test'
import { retainedCells, encodeValues, decodeValues, type Candidate } from './checkpoint'
import type { Value } from './values'

const owner = {}
function cell(id: string, value: unknown): Candidate { return { id, kind: 'ref', owner, value } }

test('retains an unchanged feed while a separate draft changes', () => {
  const before = [cell('feed', new Map([['one', { title: 'saved' }]])), cell('draft', 'old')]
  const after = [cell('feed', structuredClone(before[0]!.value)), cell('draft', 'typed')]
  expect([...retainedCells(before, after).retained]).toEqual(['feed'])
  ;(after[0]!.value as Map<string, { title: string }>).get('one')!.title = 'edited without a render'
  expect(retainedCells(before, after).retained.size).toBe(0)
})

test('joining and splitting aliases retain one consistent correspondence', () => {
  const shared = { title: 'same' }
  const joined = [cell('feed', [shared]), cell('selection', shared)]
  const split = [cell('feed', [{ title: 'same' }]), cell('selection', { title: 'same' })]
  expect([...retainedCells(joined, split).retained]).toEqual(['feed'])
  expect([...retainedCells(split, joined).retained]).toEqual(['feed'])
  const row = { title: 'edited' }
  expect(retainedCells(joined, [cell('feed', [row]), cell('selection', row)]).retained.size).toBe(0)
  const unchanged = structuredClone(joined).map(cell => ({ ...cell, owner }))
  expect(retainedCells(joined, unchanged).retained.size).toBe(2)
  expect(retainedCells(joined, [...unchanged, cell('new', unchanged[0]!.value)]).retained.size).toBe(2)
})

test('new aliases refer into retained data without copying it or using magic properties', () => {
  const row = { title: 'saved', marker: { index: 9 } }, oldFeed = [row]
  const newFeed = structuredClone(oldFeed)
  const before = [cell('feed', oldFeed)], current = [cell('feed', newFeed), cell('selection', newFeed[0])]
  const { reverse } = retainedCells(before, current)
  const base = [oldFeed]
  const packet = encodeValues([{ chosen: newFeed[0] }], base, reverse)
  expect(packet.references).toHaveLength(1)
  expect(JSON.stringify(packet)).not.toContain('saved')
  const received = structuredClone(packet)
  const decoded = decodeValues(received.values, received.references, base) as { chosen: typeof row }[]
  expect(decoded[0]!.chosen).toBe(row)
  expect(decoded[0]!.chosen.marker.index).toBe(9)
  const split: Value[] = [{ chosen: structuredClone(row) }]
  const detached = encodeValues(split, base, reverse)
  expect(detached.references).toHaveLength(0)
  expect((decodeValues(detached.values, [], base)[0] as typeof decoded[0])!.chosen).not.toBe(row)
})

test('checkpoint paths retain Map and Set entry identities after message cloning', () => {
  for (const kind of ['map', 'set'] as const) {
    const oldRow = { title: 'saved' }
    const old: Value = kind === 'map' ? new Map([['one', oldRow]]) : new Set([oldRow])
    const current = structuredClone(old)
    const row = current instanceof Map ? current.get('one') : [...current][0]
    const { reverse } = retainedCells([cell('rows', old)], [cell('rows', current)])
    const packet = structuredClone(encodeValues([row], [old], reverse))
    expect(packet.references).toHaveLength(1)
    expect(decodeValues(packet.values, packet.references, [old])[0]).toBe(oldRow)
  }
})

test('remounts, executable additions and cycles cannot masquerade as retained data', () => {
  const before = [cell('data', { title: 'saved' })]
  expect(retainedCells(before, [{ ...before[0]!, owner: {} }]).retained.size).toBe(0)
  let reads = 0
  const accessor = { get title() { reads++; return 'saved' } }
  expect(retainedCells(before, [cell('data', accessor)]).retained.size).toBe(0)
  const hidden = Object.defineProperty({ title: 'saved' }, 'resource', { value: () => {} })
  expect(retainedCells(before, [cell('data', hidden)]).retained.size).toBe(0)
  const cycle: { title: string; next?: unknown } = { title: 'saved' }
  cycle.next = cycle
  expect(retainedCells(before, [cell('data', cycle)]).retained.size).toBe(0)
  expect(reads).toBe(0)
})
