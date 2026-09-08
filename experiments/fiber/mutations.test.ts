import { expect, test } from 'bun:test'
import { mutations } from './mutations'

test('proxy experiment observes nested writes and ordered collection mutations', () => {
  const tracker = mutations(), row = { title: 'before' }
  const value = tracker.wrap({ rows: [row], selected: row, map: new Map([['one', row]]), set: new Set([row]) })
  expect(value.rows[0]).toBe(value.selected)
  expect(value.map.get('one')).toBe(value.selected)
  expect([...value.set][0]).toBe(value.selected)
  const actions = [
    () => { value.selected.title = 'after' },
    () => { value.rows.push({ title: 'appended' }) },
    () => { value.map.set('two', { title: 'new' }) },
    () => { value.map.get('one')!.title = 'through map' },
    () => { value.set.add({ title: 'added' }) },
    () => { Object.defineProperty(value.selected, 'title', { value: 'defined' }) },
  ]
  for (const action of actions) { const before = tracker.revision(); action(); expect(tracker.revision()).toBeGreaterThan(before) }
})

test('falsifier: a raw alias retained before wrapping bypasses the mutation observer', () => {
  const tracker = mutations(), raw = { row: { title: 'before' }, rows: new Map([['one', 1]]) }
  const observed = tracker.wrap(raw)
  const before = tracker.revision()
  raw.row.title = 'escaped write'; raw.rows.set('two', 2)
  expect(observed.row.title).toBe('escaped write')
  expect(observed.rows.size).toBe(2)
  expect(tracker.revision()).toBe(before)
  expect(observed).not.toBe(raw)
})

test('falsifier: a newly inserted raw object can still be changed outside the proxy', () => {
  const tracker = mutations(), observed = tracker.wrap<{ row: { title: string } | null }>({ row: null })
  const received = { title: 'received' }
  observed.row = received
  const before = tracker.revision()
  received.title = 'later write'
  expect(observed.row!.title).toBe('later write')
  expect(tracker.revision()).toBe(before)
})
