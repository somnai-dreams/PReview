import {expect,test} from 'bun:test'
import {liveProofs} from './live-proofs'
import {data} from './validate'
import {repairJournal} from './repair-journal'
import {nativeWriter,receiveInitial,sendInitial,type Initial} from './raw-transfer'
import {captureRoots} from './capture-roots'
import {observeNativeWrites} from '../native-writes'
import type {Schema,Value} from '../values'

test('an effect changes only a leaf before-image while aliases and the large library stay shared',()=>{
 const graph=liveProofs(0),rows=Array.from({length:10000},(_,n)=>({n})),selected=rows.at(-1)!,root={rows,selected}
 graph.accepts(data,root)
 const writer=nativeWriter(),journal=repairJournal(graph,[{schema:data,value:root}],writer),stop=observeNativeWrites(graph.touch),reads=graph.stats().reads
 try{
  Object.assign(selected,{n:99999});expect(root.rows.at(-1)!.n).toBe(99999)
  expect(journal.objects()).toBe(1);expect(journal.repair()).toEqual({ok:true,objects:1});expect(selected.n).toBe(9999)
  expect(root.selected).toBe(root.rows.at(-1)!);expect(journal.changed()).toEqual([]);expect(graph.dirty.size).toBe(0)
  expect(graph.stats().reads-reads).toBe(3)
 }finally{journal.close();stop()}
})
test('newly adopted native values can be repaired without retaining a separate graph copy',()=>{
 const a=liveProofs(0),b=liveProofs(1);let packet:Initial|undefined
 sendInitial(a,captureRoots(a,[{schema:data,value:{row:{n:1}}}],true),{postMessage(value:Initial){packet=structuredClone(value)}})
 const result=receiveInitial(b,packet!,[{schema:data,value:undefined,kind:'ref'}],nativeWriter());if(!result.ok)throw Error(result.reason)
 const root=result.values[0] as {row:{n:number}},held=root.row
 expect(Object.is(root,packet!.values[0])).toBe(true)
 const journal=repairJournal(b,[{schema:data,value:root}],nativeWriter())
 try{
  b.touch(root).row={n:9};b.touch(held).n=7
  expect(journal.objects()).toBe(2);expect(journal.repair().ok).toBe(true)
  expect(root.row).toBe(held);expect(held.n).toBe(1);expect(journal.changed()).toEqual([])
 }finally{journal.close()}
})
test('collection order, deleted fields and aliases survive native effect writes',()=>{
 const graph=liveProofs(0),one={n:1},two={n:2},root={map:new Map([['a',one],['b',two]]),set:new Set([one,two]),array:[one,two],object:{one,two} as Record<string,Value>}
 graph.accepts(data,root)
 const writer=nativeWriter(),journal=repairJournal(graph,[{schema:data,value:root}],writer),stop=observeNativeWrites(graph.touch)
 try{
  root.map.delete('a');root.map.set('a',two);root.set.delete(one);root.set.add(one);root.array.splice(0,1);Reflect.deleteProperty(root.object,'one');Object.assign(root.object,{newValue:'bad'})
  expect(journal.objects()).toBe(4);expect(journal.repair().ok).toBe(true)
  expect([...root.map.keys()]).toEqual(['a','b']);expect(root.map.get('a')).toBe(one)
  expect([...root.set]).toEqual([one,two]);expect(root.array).toEqual([one,two]);expect(root.object).toEqual({one,two});expect(journal.changed()).toEqual([])
 }finally{journal.close();stop()}
})
test('repeated effects remain reported as changed and retain their dirty record',()=>{
 const graph=liveProofs(0),value={n:1};graph.accepts(data,value)
 const journal=repairJournal(graph,[{schema:data,value}],nativeWriter())
 try{
  graph.touch(value).n=2;expect(journal.repair().ok).toBe(true)
  graph.touch(value).n=2;expect(journal.changed()).toEqual([value]);expect(graph.dirty.size).toBe(1)
 }finally{journal.close()}
})
test('a rejected repair writes nothing and does not certify successful candidate prefixes',()=>{
 const graph=liveProofs(0),a={n:1},b={n:1},roots=[{schema:data,value:a},{schema:data,value:b}]
 graph.accepts(data,a);graph.accepts(data,b)
 const writer=nativeWriter(),journal=repairJournal(graph,roots,writer),stop=observeNativeWrites(graph.touch)
 try{
  Object.assign(a,{n:2});Object.assign(b,{n:2});Object.freeze(b)
  expect(journal.repair()).toEqual({ok:false,reason:'non-writable',objects:2});expect(a.n).toBe(2);expect(b.n).toBe(2);expect(journal.changed()).toHaveLength(2)
 }finally{journal.close();stop()}
})
test('the journal neither invokes an effect getter nor loses pre-existing drift',()=>{
 const graph=liveProofs(0),value={n:1},map=new Map([['x',value]])
 graph.accepts(data,map);graph.touch(value).n=2;graph.accepts(data,map)
 const writer=nativeWriter(),journal=repairJournal(graph,[{schema:data,value:map}],writer),stop=observeNativeWrites(graph.touch)
 let reads=0
 try{
  Object.assign(value,{n:3});Object.defineProperty(map,'entries',{enumerable:true,configurable:true,get(){reads++;throw Error('Must not execute')}})
  expect(journal.changed()).toHaveLength(2);expect(journal.repair().ok).toBe(false);expect(reads).toBe(0)
  Reflect.deleteProperty(map,'entries');expect(journal.repair().ok).toBe(true);expect(value.n).toBe(2);expect(graph.dirty.has(graph.get(value))).toBe(true)
 }finally{journal.close();stop()}
})
test('a type-invalid repair rejects before modifying any body',()=>{
 const graph=liveProofs(0),value={n:1};graph.accepts(data,value)
 const wrong:Schema={root:0,nodes:[{kind:'primitive',name:'string'}]},journal=repairJournal(graph,[{schema:wrong,value}],nativeWriter())
 try{graph.touch(value).n=2;expect(journal.repair()).toEqual({ok:false,reason:'root-type',objects:1});expect(value.n).toBe(2)}finally{journal.close()}
})
