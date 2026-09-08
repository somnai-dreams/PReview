import { expect, test } from 'bun:test'
import { incrementalCache } from './incremental'
import { comparison, restoration, reconcile } from './values'

function indexed<T extends object>(target: T) {
  const source = structuredClone(target), cache = incrementalCache()
  expect(comparison().matches(source, target)).toBe(true)
  cache.keep([{ source, target }])
  return { source, cache, matches: () => comparison(undefined, cache.phase()).matches(source, target) }
}

test('same-value writes retain the graph index and a real field edit stays invalid until restored', () => {
  const target = { row: { title: 'first', selected: false } }, { cache, matches } = indexed(target)
  const indexedRoots = cache.stats().indexedRoots
  cache.touch(target.row, 'property', 'title').title = 'first'
  expect(matches()).toBe(true)
  expect(cache.stats().hits).toBe(1)
  expect(cache.stats().indexedRoots).toBe(indexedRoots)
  cache.touch(target.row, 'property', 'selected').selected = true
  expect(matches()).toBe(false)
  cache.touch(target.row, 'property', 'title').title = 'first'
  expect(matches()).toBe(false)
  cache.touch(target.row, 'property', 'selected').selected = false
  expect(matches()).toBe(true)
})

test('array truncation cannot hide removed entries by restoring length alone', () => {
  const target = [1, 2, 3], { cache, matches } = indexed(target)
  cache.touch(target, 'property', 'length').length = 1
  cache.touch(target, 'property', 'length').length = 3
  expect(matches()).toBe(false)
})

test('an equal replacement is reindexed so subsequent edits through its raw alias are seen', () => {
  const target = { row: { title: 'first' } }, { cache, source, matches } = indexed(target)
  const replacement = { title: 'first' }
  cache.touch(target, 'property', 'row').row = replacement
  expect(matches()).toBe(true) // Full comparison can accept equal new identities.
  expect(cache.stats().hits).toBe(0)
  cache.keep([{ source, target }])
  cache.touch(replacement, 'property', 'title').title = 'second'
  expect(matches()).toBe(false)
})

test('shared aliases cannot conflict with an activated proof or an earlier uncached match', () => {
  const target = { row: { title: 'first' } }, { cache, source } = indexed(target)
  const phase = comparison(undefined, cache.phase())
  expect(phase.matches(source, target)).toBe(true)
  expect(phase.matches(source.row, { title: 'first' })).toBe(false)
  expect(phase.matches({ title: 'first' }, target.row)).toBe(false)
  const otherPhase = comparison(undefined, cache.phase()), replacement = { title: 'first' }
  expect(otherPhase.matches(source.row, replacement)).toBe(true)
  expect(otherPhase.matches(source, target)).toBe(false)
})

test('failed candidate rollback restores eligibility for a cached proof', () => {
  const target = { row: { count: 1 } }, { cache, source } = indexed(target)
  const phase = comparison(undefined, cache.phase())
  expect(phase.matches({ row: source.row, fail: 1 }, { row: { count: 1 }, fail: 2 })).toBe(false)
  expect(phase.matches(source, target)).toBe(true)
  expect(cache.stats().hits).toBe(1)
})

test('cached correspondences restore new aliases without enumerating the retained graph', () => {
  const target = { row: { count: 1 } }, { cache, source } = indexed(target)
  const phase = comparison(undefined, cache.phase())
  expect(phase.matches(source, target)).toBe(true)
  const context = restoration(phase.pairs, phase.reverse)
  expect(context.copies.changed.size).toBe(0)
  expect(reconcile({ selected: source.row }, undefined, context)).toEqual({ selected: target.row })
  expect(context.copies.get(source.row)?.value).toBe(target.row)
  expect(context.copies.changed.size).toBe(1)
})

test('incomplete observation uses full comparison and catches an unobserved edit', () => {
  const target = { count: 1 }, { cache, matches } = indexed(target)
  cache.coverage(false)
  target.count++
  expect(matches()).toBe(false)
  expect(cache.stats().roots).toBe(0)
})

test('invalid accessors and collection order changes cannot receive a cached match', () => {
  const target = { count: 1 }, { cache, matches } = indexed(target)
  cache.touch(target, 'defineProperty')
  Object.defineProperty(target, 'count', { enumerable: true, get() { throw new Error('Must not evaluate') } })
  expect(matches()).toBe(false)
  const map = new Map([['a', 1], ['b', 2]]), indexedMap = indexed(map)
  indexedMap.cache.touch(map, 'delete'); map.delete('a'); map.set('a', 1)
  expect(indexedMap.matches()).toBe(false)
})
