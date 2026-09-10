import type { Schema, Shape } from '../values'

export type Proofs = {
  identity: (value: object) => object
  read: (value: object) => object
  known: (schema: Schema, value: object, id: number) => number | undefined
  remember: (schema: Schema, value: object, id: number, height: number) => void
  pair?: (value:object,candidate:unknown)=>object
  child?: (parent:object,child:object)=>void
}
export const data: Schema = { root: 0, nodes: [{ kind: 'data' }] }
const dataArray: Shape = { kind: 'array', item: 0 }, dataMap: Shape = { kind: 'map', key: 0, value: 0 }, dataSet: Shape = { kind: 'set', item: 0 }, dataObject: Shape = { kind: 'object', fields: [], index: 0 }
export const container = (value: unknown): value is object => value !== null && typeof value === 'object'
const scalar = (value: unknown) => value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)

// A successful proof includes the recursion height, so reusing it beneath a
// new wrapper cannot bypass the same depth bound as fresh validation. The view
// may substitute a proposed container while retaining its canonical identity.
export function validate(schema: Schema, value: unknown, proofs?: Proofs, root = schema.root, candidate?:unknown): boolean {
  const active = new Set<object>()
  function check(schema: Schema, value: unknown, id: number, depth: number, candidate?:unknown): number | undefined {
    if (container(value) && proofs !== undefined) value = proofs.identity(value)
    if (depth > 100 || container(value) && active.has(value)) return undefined
    const target=container(value)?proofs?.pair?.(value,candidate):undefined
    if (container(value)) {
      const height = proofs?.known(schema, value, id)
      if (height !== undefined && depth + height <= 100) return height
    }
    const shape = schema.nodes[id]
    if (shape === undefined) throw Error('Invalid schema reference')
    if (container(value) && (shape.kind === 'primitive' || shape.kind === 'literal' || shape.kind === 'reject')) return undefined
    const input = container(value) && proofs !== undefined && shape.kind !== 'union' ? proofs.read(value) : value
    if (container(value) && shape.kind !== 'union') active.add(value)
    const height = examine(schema, input, shape, depth,target,value)
    if (container(value)) {
      if (shape.kind !== 'union') active.delete(value)
      if (height !== undefined) proofs?.remember(schema, value, id, height)
    }
    return height
  }
  function examine(schema: Schema, value: unknown, shape: Shape, depth: number,target?:object,owner:unknown=value): number | undefined {
    let height = 0
    function child(value: unknown, childSchema: Schema, id: number,candidate?:unknown) {
      const result = check(childSchema, value, id, depth + 1,candidate)
      if (result === undefined) return false
      if(container(owner)&&container(value))proofs?.child?.(owner,value)
      height = Math.max(height, result + 1)
      return true
    }
    function fieldCandidate(key:PropertyKey,item:unknown){return target===undefined||target===value||!container(item)?undefined:Object.getOwnPropertyDescriptor(target,key)?.value}
    switch (shape.kind) {
      case 'reject': return undefined
      case 'primitive': return scalar(value) && typeof value === shape.name ? 0 : undefined
      case 'literal': return scalar(value) && value === shape.value ? 0 : undefined
      case 'union': {
        for (const member of shape.members) {
          const result = check(schema, value, member, depth + 1,target)
          if (result !== undefined) return result + 1
        }
        return undefined
      }
      case 'data': {
        if (!container(value)) return scalar(value) ? 0 : undefined
        if (Array.isArray(value)) return examine(data, value, dataArray, depth,target,owner)
        if (value instanceof Map) return examine(data, value, dataMap, depth,target,owner)
        if (value instanceof Set) return examine(data, value, dataSet, depth,target,owner)
        return examine(data, value, dataObject, depth,target,owner)
      }
      case 'array': case 'tuple': {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) return undefined
        if (shape.kind === 'tuple' && (value.length < shape.required || value.length > shape.items.length)) return undefined
        for (let index = 0; index < value.length; index++) {
          const field = Object.getOwnPropertyDescriptor(value, index), item = shape.kind === 'tuple' ? shape.items[index]! : shape.item
          if (field === undefined || !('value' in field) || !field.enumerable || !child(field.value, schema, item,fieldCandidate(index,field.value))) return undefined
        }
        return height
      }
      case 'set': {
        if (!(value instanceof Set) || Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length !== 0) return undefined
        const candidates=target===undefined||target===value?undefined:(target as Set<unknown>).values()
        for (const item of value) if (!child(item, schema, shape.item,candidates?.next().value)) return undefined
        return height
      }
      case 'map': {
        if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length !== 0) return undefined
        for (const [key, item] of value) if (!scalar(key) || !child(key, schema, shape.key) || !child(item, schema, shape.value,target===undefined||target===value||!container(item)?undefined:(target as Map<unknown,unknown>).get(key))) return undefined
        return height
      }
      case 'object': {
        if (!container(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return undefined
        let present = 0
        for (const field of shape.fields) {
          const descriptor = Object.getOwnPropertyDescriptor(value, field.name)
          if (descriptor === undefined) { if (!field.optional && !child(undefined, schema, field.shape)) return undefined }
          else {
            if (!('value' in descriptor) || !descriptor.enumerable || !child(descriptor.value, schema, field.shape,fieldCandidate(field.name,descriptor.value))) return undefined
            present++
          }
        }
        const keys = Object.getOwnPropertyNames(value)
        if (keys.length === present) return height
        const declared = shape.fields.length === 0 ? undefined : new Set(shape.fields.map(field => field.name))
        for (const key of keys) {
          if (declared?.has(key)) continue
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!
          if (!('value' in descriptor) || !descriptor.enumerable || !child(descriptor.value, shape.index === null ? data : schema, shape.index ?? 0,fieldCandidate(key,descriptor.value))) return undefined
        }
        return height
      }
    }
  }
  return check(schema, value, root, 0,candidate) !== undefined
}
