import { expect, test } from 'bun:test'
import { accepts, equal, matchesRestoration, reconcile, restoration, type Schema } from './values'

test('selective repair reconnects a reset cell to an unchanged shared container', () => {
  const row = { title: 'saved' }
  const source = new Map([['one', row]])
  const context = restoration()
  const destination = reconcile(source, new Map(), context) as Map<string, typeof row>
  const selected = reconcile(row, undefined, context)
  expect(selected).toBe(destination.get('one'))
  expect(matchesRestoration(source, destination, context)).toBe(true)
  expect(matchesRestoration(row, { title: 'saved' }, context)).toBe(false)
  context.pass++
  expect(reconcile(row, { title: 'reset' }, context)).toBe(selected)
  expect(selected).toBe(destination.get('one'))
  expect(matchesRestoration(source, destination, context)).toBe(true)
})

test('selective repair restores in-place changes without replacing shared objects', () => {
  const source = { row: { title: 'saved' } }
  const context = restoration()
  const target = reconcile(source, undefined, context) as typeof source
  const row = target.row
  target.row.title = 'mount reset'
  expect(matchesRestoration(source, target, context)).toBe(false)
  context.pass++
  expect(reconcile(source, target, context)).toBe(target)
  expect(target.row).toBe(row)
  expect(row.title).toBe('saved')
  target.row = { title: 'saved' }
  expect(matchesRestoration(source, target, context)).toBe(false)
  context.pass++
  reconcile(source, target, context)
  expect(target.row).toBe(row)
})

test('Map and tuple validation checks populated entries, keys and length', () => {
  const schema: Schema = { root: 0, nodes: [
    { kind: 'map', key: 1, value: 2 }, { kind: 'primitive', name: 'string' },
    { kind: 'tuple', items: [3, 3], required: 2 }, { kind: 'primitive', name: 'number' },
  ] }
  expect(accepts(schema, new Map([['one', [10, 20]]]))).toBe(true)
  expect(accepts(schema, new Map([[1, [10, 20]]]))).toBe(false)
  expect(accepts(schema, new Map([['one', [10, 'bad']]]))).toBe(false)
  expect(accepts(schema, new Map([['one', [10]]]))).toBe(false)
  expect(accepts(schema, new Map([['one', [10, 20, 30]]]))).toBe(false)
  expect(accepts(schema, { one: [10, 20] })).toBe(false)
})

test('restoration keeps Map, array and object identities held by existing consumers', () => {
  const row = { title: 'old', tags: ['old'] }
  const rows = [row]
  const feed = new Map([['feed', rows]])
  const sourceRow = { title: 'new', tags: ['one', 'two'] }
  const source = new Map([['feed', [sourceRow]]])
  const context = restoration()
  expect(reconcile(source, feed, context)).toBe(feed)
  expect(feed.get('feed')).toBe(rows)
  expect(rows[0]).toBe(row)
  expect(row).toEqual(sourceRow)
  expect(reconcile(sourceRow, { title: 'separate', tags: [] }, context)).toBe(row)
  row.tags.push('continued edit')
  expect(sourceRow.tags).toEqual(['one', 'two'])
})

test('shared source objects stay shared and separate source objects do not collapse', () => {
  const shared = { count: 2 }
  const source = { left: shared, right: shared }
  const result = reconcile(source, { left: { count: 0 }, right: { count: 1 } }, restoration()) as typeof source
  expect(result.left).toBe(result.right)
  const destinationShared = { count: 0 }
  const split = reconcile({ left: { count: 2 }, right: { count: 3 } }, { left: destinationShared, right: destinationShared }, restoration()) as typeof source
  expect(split.left).not.toBe(split.right)
  expect(split.left.count).toBe(2)
  expect(split.right.count).toBe(3)
})

test('equality sees Map edits, iteration order and broken aliases', () => {
  expect(equal(new Map([['one', 1]]), new Map([['one', 2]]))).toBe(false)
  expect(equal(new Map([['one', 1], ['two', 2]]), new Map([['two', 2], ['one', 1]]))).toBe(false)
  const shared = { id: 'one' }
  expect(equal({ a: shared, b: shared }, structuredClone({ a: shared, b: shared }))).toBe(true)
  expect(equal({ a: shared, b: shared }, { a: { id: 'one' }, b: { id: 'one' } })).toBe(false)
})

test('accessors are not evaluated as checkpoint data', () => {
  let reads = 0
  const value = { get title() { reads++; return 'data' } }
  const schema: Schema = { root: 0, nodes: [
    { kind: 'object', fields: [{ name: 'title', optional: false, shape: 1 }], index: null },
    { kind: 'primitive', name: 'string' },
  ] }
  expect(accepts(schema, value)).toBe(false)
  expect(equal({ title: 'data' }, value)).toBe(false)
  const array = [0]
  Object.defineProperty(array, '0', { get() { reads++; return 1 } })
  expect(accepts({ root: 0, nodes: [{ kind: 'array', item: 1 }, { kind: 'primitive', name: 'number' }] }, array)).toBe(false)
  expect(equal([0], array)).toBe(false)
  expect(reads).toBe(0)
})

test('restoration replaces arrays that cannot accept the new entries', () => {
  const source = [1, 2]
  for (const destination of [Object.freeze([0]), Object.seal([0]), Object.preventExtensions([0])]) {
    const result = reconcile(source, destination, restoration())
    expect(result).toEqual(source)
    expect(result).not.toBe(destination)
  }
})

test('unknown fields still reject live resources and cyclic graphs', () => {
  const schema: Schema = { root: 0, nodes: [{ kind: 'data' }] }
  expect(accepts(schema, { extras: new Map([['one', [1, 'two']]]) })).toBe(true)
  expect(accepts(schema, new Map([[{ id: 'one' }, 'value']]))).toBe(false)
  class ResourceMap extends Map<string, number> { callback = () => {} }
  expect(accepts(schema, new ResourceMap())).toBe(false)
  expect(equal(new Map(), new ResourceMap())).toBe(false)
  expect(accepts(schema, new AbortController())).toBe(false)
  expect(accepts(schema, { callback: () => {} })).toBe(false)
  expect(accepts(schema, { date: new Date() })).toBe(false)
  const cycle: { next?: unknown } = {}
  cycle.next = cycle
  expect(accepts(schema, cycle)).toBe(false)
})
