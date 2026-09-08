import { expect, test } from 'bun:test'
import { observeGeneratedFunctions } from './generated-functions'
import { incrementalCache } from './incremental'
import { comparison } from './values'
import { instrumentWrites } from './write-compiler'

const bridge = globalThis as typeof globalThis & { __previewWrites?: { touch: ReturnType<typeof incrementalCache>['touch']; unobserved: () => void } }
function observe<T>(run: (cache: ReturnType<typeof incrementalCache>, generated: ReturnType<typeof observeGeneratedFunctions>) => T): T {
  const cache = incrementalCache(), previous = Object.getOwnPropertyDescriptor(bridge, '__previewWrites')
  bridge.__previewWrites = { touch: cache.touch, unobserved: () => cache.coverage(false) }
  const generated = observeGeneratedFunctions(() => cache.coverage(false))
  try { return run(cache, generated) } finally {
    generated.stop()
    if (previous === undefined) delete bridge.__previewWrites
    else Object.defineProperty(bridge, '__previewWrites', previous)
  }
}
function watch(cache: ReturnType<typeof incrementalCache>, target: object) {
  const source = structuredClone(target)
  cache.keep([{ source, target }])
  return () => comparison(undefined, cache.phase()).matches(source, target)
}

test('generated closures and captured Function aliases observe writes without rendering', () => observe((cache, generated) => {
  const target = { count: 1 }, matches = watch(cache, target)
  const Alias = Function
  const factory = new Alias('return value => value.count++') as () => (value: typeof target) => number
  const write = factory()
  expect(matches()).toBe(true)
  expect(write(target)).toBe(1)
  expect(matches()).toBe(false)
  expect(generated.stats().transformed).toBe(1)
  expect(cache.stats().coverage).toBe(true)
  const fromPrototype = (() => {}).constructor('value', 'value.count = 1') as (value: typeof target) => void
  fromPrototype(target)
  expect(matches()).toBe(true)
}))

test('default parameters, strict this, length and anonymous binding keep native behavior', () => observe((cache) => {
  const target = { count: 1 }, matches = watch(cache, target)
  const fn = new Function('input', 'next = input.count++', 'return [next, input.count, typeof anonymous]') as (input: typeof target) => unknown
  expect(fn.name).toBe('anonymous')
  expect(fn.length).toBe(1)
  expect(fn(target)).toEqual([1, 2, 'undefined'])
  expect(matches()).toBe(false)
  const strict = new Function('input', '"use strict"; input.count++; return this') as (input: typeof target) => unknown
  expect(strict(target)).toBeUndefined()
}))

test('coercion and newTarget prototype lookup happen once; syntax errors remain native', () => observe(() => {
  let coerced = 0, prototypes = 0
  const body = { toString() { coerced++; return 'value.count++; return value.count' } }
  class Custom extends Function {}
  const NewTarget = new Proxy(Custom, { get(target, key, receiver) { if (key === 'prototype') prototypes++; return Reflect.get(target, key, receiver) } })
  const fn = Reflect.construct(Function, ['value', body], NewTarget) as (value: {count:number}) => number
  expect(coerced).toBe(1)
  expect(prototypes).toBe(1)
  expect(Object.getPrototypeOf(fn)).toBe(Custom.prototype)
  expect(fn({count:2})).toBe(3)
  expect(() => Reflect.construct(Function, [Symbol('invalid')])).toThrow(TypeError)
  expect(() => new Function('value', 'value. = 3')).toThrow(SyntaxError)
}))

test('async and generator constructors are covered through their prototype aliases', async () => {
  // Await inside the scope explicitly so patched constructors are restored last.
  const cache = incrementalCache(), previous = Object.getOwnPropertyDescriptor(bridge, '__previewWrites')
  bridge.__previewWrites = { touch: cache.touch, unobserved: () => cache.coverage(false) }
  const generated = observeGeneratedFunctions(() => cache.coverage(false))
  try {
    const target = {count:1}, matches = watch(cache, target)
    const Async = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor
    const run = new Async('value', 'await Promise.resolve(); value.count++; return value.count') as (v:typeof target)=>Promise<number>
    expect(await run(target)).toBe(2)
    expect(matches()).toBe(false)
    const Generator = Object.getPrototypeOf(function* () {}).constructor as FunctionConstructor
    const iterate = new Generator('value', 'value.count = 1; yield value.count') as (v:typeof target)=>Generator<number>
    expect(iterate(target).next().value).toBe(1)
    expect(matches()).toBe(true)
    const AsyncGenerator = Object.getPrototypeOf(async function* () {}).constructor as FunctionConstructor
    const iterateAsync = new AsyncGenerator('value', 'value.count++; yield value.count') as (v:typeof target)=>AsyncGenerator<number>
    expect((await iterateAsync(target).next()).value).toBe(2)
    expect(matches()).toBe(false)
    expect(generated.stats().transformed).toBe(3)
  } finally {
    generated.stop()
    if (previous === undefined) delete bridge.__previewWrites
    else Object.defineProperty(bridge, '__previewWrites', previous)
  }
})

test('capability checks and ordinary constructors do not disable observation', () => observe((cache, generated) => {
  expect(new Function('')()).toBeUndefined()
  const result = instrumentWrites('example.js', 'new input.constructor(3)')
  expect(result.opaque).toBe(0)
  expect(cache.stats().coverage).toBe(true)
  expect(generated.stats().transformed).toBe(0)
}))

test('unsupported generated scope and executed eval retain the full-check fallback', () => observe((cache) => {
  const evalFn = new Function('let local = 1; eval("local = 7"); return local') as () => number
  expect(cache.stats().coverage).toBe(true)
  expect(evalFn()).toBe(7)
  expect(cache.stats().coverage).toBe(false)
  cache.coverage(true)
  const shadowed = new Function('globalThis', 'value', 'value.count++') as (global: object, value:{count:number})=>void
  expect(cache.stats().coverage).toBe(false)
  const value = {count:1}; shadowed({}, value); expect(value.count).toBe(2)
  cache.coverage(true)
  const shadowedEval = new Function('globalThis', 'code', 'return eval(code)') as (global:object, code:string)=>number
  expect(cache.stats().coverage).toBe(false)
  expect(shadowedEval({}, '3')).toBe(3)
}))
