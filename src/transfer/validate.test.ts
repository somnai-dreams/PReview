import { expect, test } from 'bun:test'
import { accepts, type Schema } from '../values'
import { data, validate, type Proofs } from './validate'

function immutableProofs() {
  const entries = new WeakMap<Schema, Map<number, WeakMap<object, number>>>()
  let reads = 0
  const proofs: Proofs = {
    identity: value => value,
    read: value => { reads++; return value },
    known: (schema, value, id) => entries.get(schema)?.get(id)?.get(value),
    remember(schema, value, id, height) {
      let ids=entries.get(schema);if(ids===undefined){ids=new Map();entries.set(schema,ids)}
      let values=ids.get(id);if(values===undefined){values=new WeakMap();ids.set(id,values)}
      values.set(value,height)
    }
  }
  return {proofs,reads:()=>reads}
}

test('fresh validation agrees with the existing data and generated-shape boundary', () => {
  const schemas:Schema[]=[data,{root:0,nodes:[{kind:'map',key:1,value:2},{kind:'primitive',name:'string'},{kind:'tuple',items:[3,3],required:1},{kind:'primitive',name:'number'}]},
    {root:0,nodes:[{kind:'object',fields:[{name:'n',shape:1,optional:false},{name:'extra',shape:2,optional:true}],index:null},{kind:'primitive',name:'number'},{kind:'union',members:[1,3]},{kind:'primitive',name:'undefined'}]}]
  const cyclic:{next?:unknown}={};cyclic.next=cyclic
  const sparse:unknown[]=[1,2,3];delete sparse[1]
  const values:unknown[]=[null,undefined,1,NaN,Infinity,'text',true,{},[],sparse,new Date(),()=>{},new Map([['a',[1,2]]]),new Map([['a',[1,'bad']]]),new Set([1,'two']),{n:1},{n:1,safe:{value:1}},{n:1,unsafe:()=>{}},{get n(){throw Error('Must not execute')}},cyclic]
  for(const schema of schemas)for(const value of values)expect(validate(schema,value)).toBe(accepts(schema,value))
})
test('unchanged subtrees are reused when wrapped in a new root', () => {
  const value=Array.from({length:10000},(_,n)=>({n})), cache=immutableProofs()
  expect(validate(data,value,cache.proofs)).toBe(true);const before=cache.reads()
  expect(validate(data,{value},cache.proofs)).toBe(true);expect(cache.reads()-before).toBe(1)
})
test('cached subtrees do not bypass depth rejection after wrapping', () => {
  let value:unknown={leaf:1};for(let i=0;i<99;i++)value={value}
  const cache=immutableProofs();expect(validate(data,value,cache.proofs)).toBe(true)
  expect(validate(data,{value},cache.proofs)).toBe(false);expect(validate(data,{value})).toBe(false)
})
test('a shallower valid union alternative is considered if a cached branch no longer fits', () => {
  const schema:Schema={root:0,nodes:[{kind:'union',members:[1,2]},{kind:'union',members:[2]},{kind:'data'},{kind:'object',fields:[{name:'value',optional:false,shape:0}],index:null}]}
  let value:unknown={leaf:1};for(let i=0;i<97;i++)value={value}
  const cache=immutableProofs();expect(validate(schema,value,cache.proofs)).toBe(true)
  expect(cache.proofs.known(schema,value as object,0)).toBe(100)
  expect(validate(schema,{value},cache.proofs,3)).toBe(true)
  expect(validate(schema,{value},undefined,3)).toBe(true)
})
test('proposed values are checked under canonical identity without mutating current values', () => {
  const current={n:1}, proposed={n:'invalid'}, schema:Schema={root:0,nodes:[{kind:'object',fields:[{name:'n',optional:false,shape:1}],index:null},{kind:'primitive',name:'number'}]}
  const proofs:Proofs={identity:value=>value,read:value=>value===current?proposed:value,known:()=>undefined,remember(){}}
  expect(validate(schema,current,proofs)).toBe(false);expect(current.n).toBe(1)
})
