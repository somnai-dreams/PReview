import {captureRoots} from './capture-roots'
import {expect,test} from 'bun:test'
import {liveProofs} from './live-proofs'
import {data} from './validate'
import {sendInitial as postInitial,receiveInitial as restoreInitial,nativeWriter,type Initial, type Root} from './raw-transfer'
import {sendDelta as postDelta,receiveDelta as restoreDelta,type Delta} from './delta-transfer'
import type {Schema,Value} from '../values'
function setup(value:Value,target:Value){
 const a=liveProofs(0),b=liveProofs(1),write=nativeWriter();let packet:Initial|undefined
 sendInitial(a,[{schema:data,value}],{postMessage(value:Initial){packet=structuredClone(value)}})
 const received=receiveInitial(b,packet!,[{schema:data,value:target}],write)
 if(!received.ok)throw Error(received.reason)
 a.share();b.share();return {a,b,write,target:received.values[0]}
}
function transfer(a:ReturnType<typeof liveProofs>,b:ReturnType<typeof liveProofs>,roots:Root[],targets:Root[],remoteDirty:number[]=[]){
 let packet:Delta|undefined
 const sent=sendDelta(a,roots,{postMessage(value:Delta){packet=structuredClone(value)}},remoteDirty)
 try{const received=receiveDelta(b,packet!,targets,nativeWriter());if(!received.ok)throw Error(received.reason);sent.acknowledge(true);return {packet:packet!,sent,received}}catch(error){sent.acknowledge(false);throw error}
}
const cells=(value:Value)=>[{schema:data,value}]
test('a wrapper transfers as one ordinary object and a library reference',()=>{
 const rows=Array.from({length:100000},(_,n)=>({n})),{a,b,target}=setup(rows,[])
 const beforeA=a.stats().reads,beforeB=b.stats().reads
 const result=transfer(a,b,cells({rows}),cells(target))
 expect(result.sent.objects).toBe(1);expect(result.sent.references).toBe(1)
 expect(a.stats().reads-beforeA).toBe(1);expect(b.stats().reads-beforeB).toBe(1)
 expect((result.received.values[0] as {rows:Value}).rows).toBe(target)
 expect((target as Value[]).length).toBe(100000)
})
test('an in-place nested edit and a return preserve previously held aliases',()=>{
 const row={n:0},root={row},pair=setup(root,{row:{n:0}}),target=pair.target as typeof root,held=target.row
 pair.a.touch(row).n=2
 const result=transfer(pair.a,pair.b,cells(root),cells(target))
 expect(result.sent.objects).toBe(1);expect(held.n).toBe(2);expect(target.row).toBe(held)
 pair.b.touch(held).n=3
 const reverse=transfer(pair.b,pair.a,cells(target),cells(root))
 expect(reverse.sent.objects).toBe(1);expect(row.n).toBe(3);expect(root.row).toBe(row)
})
test('rejected data cannot change any destination field or certify the rejected prefix',()=>{
 const schema:Schema={root:0,nodes:[{kind:'object',fields:[{name:'n',shape:1,optional:false}],index:null},{kind:'primitive',name:'number'}]},source:{n:Value}={n:1},pair=setup(source,{n:0})
 pair.a.touch(source).n='bad'
 expect(()=>transfer(pair.a,pair.b,cells(source),[{schema,value:pair.target}])).toThrow('Invalid incoming type')
 expect(pair.target).toEqual({n:1});expect(pair.a.dirty.size).toBe(1)
 pair.a.touch(source).n=2;const fixed=transfer(pair.a,pair.b,cells(source),[{schema,value:pair.target}])
 expect(fixed.received.values).toEqual([{n:2}])
})
test('writes after capture remain pending after acknowledgement',()=>{
 const source={n:1},pair=setup(source,{n:0});pair.a.touch(source).n=2
 let packet:Delta|undefined
 const sent=sendDelta(pair.a,cells(source),{postMessage(value:Delta){packet=structuredClone(value);pair.a.touch(source).n=3}})
 receiveDelta(pair.b,packet!,cells(pair.target),pair.write);sent.acknowledge(true)
 expect(pair.target).toEqual({n:2});expect(pair.a.dirty.size).toBe(1)
 transfer(pair.a,pair.b,cells(source),cells(pair.target));expect(pair.target).toEqual({n:3})
})
test('reported destination drift is restored from the source',()=>{
 const source={n:1},pair=setup(source,{n:0});pair.b.touch(pair.target as {n:number}).n=5
 const result=transfer(pair.a,pair.b,cells(source),cells(pair.target),[...pair.b.dirty].map(entry=>entry.id))
 expect(result.sent.objects).toBe(1);expect(pair.target).toEqual({n:1});expect(pair.b.dirty.size).toBe(0)
})
test('a cycle introduced by references rejects before application writes',()=>{
 const source:{child:Value}={child:null},pair=setup(source,{child:null})
 const marker={},body={child:marker},id=pair.a.get(source).id
 const packet:Delta={kind:'delta',values:[marker],objects:[body],ids:[id],references:[marker],refIds:[id]}
 expect(()=>receiveDelta(pair.b,packet,cells(pair.target),pair.write)).toThrow('Invalid incoming type')
 expect(pair.target).toEqual({child:null})
})
test('Map and Set order and joins/splits survive alternating updates',()=>{
 const one={n:1},two={n:2},source={map:new Map<string,Value>([['one',one],['two',two]]),set:new Set<Value>([one,two]),selected:one as Value},pair=setup(source,{map:new Map(),set:new Set(),selected:null})
 const target=pair.target as typeof source
 pair.a.touch(source.map).delete('one');pair.a.touch(source.map).set('one',one)
 pair.a.touch(source.set).delete(one);pair.a.touch(source.set).add(one)
 pair.a.touch(source).selected=two
 transfer(pair.a,pair.b,cells(source),cells(target))
 expect([...target.map.keys()]).toEqual(['two','one']);expect([...target.set][0]).toBe(target.selected);expect(target.map.get('two')).toBe(target.selected)
 const fresh={n:7};pair.b.touch(target.map).set('three',fresh);pair.b.touch(target).selected=fresh
 transfer(pair.b,pair.a,cells(target),cells(source))
 expect(source.selected).toEqual({n:7});expect(source.map.get('three')).toBe(source.selected)
})

test('repeated replacement and detached ownership do not retain previous graphs',()=>{
 let source:Value={rows:[{n:0}]},pair=setup(source,{rows:[]}),target=pair.target
 for(let n=1;n<=200;n++){
  source={rows:[{n}]}
  const result=transfer(pair.a,pair.b,cells(source),cells(target));target=result.received.values[0]
  expect(target).toEqual(source);expect(pair.a.stats().objects).toBe(3);expect(pair.b.stats().objects).toBe(3)
 }
 pair.a.clear();pair.b.clear();expect(pair.a.stats().objects).toBe(0);expect(pair.b.stats().objects).toBe(0)
})
test('hidden or executable data and missing identities reject before writes',()=>{
 const pair=setup({n:1},{n:0}),id=pair.a.get(pair.a.find(0)!).id
 for(const invalid of [Object.defineProperty({},'bad',{get(){throw Error('Executed getter')},enumerable:true}),Object.defineProperty({},'bad',{value:1})]){
  expect(()=>receiveDelta(pair.b,{kind:'delta',values:[invalid],objects:[invalid],ids:[id],references:[],refIds:[]},cells(pair.target),pair.write)).toThrow('Executable or hidden body')
  expect(pair.target).toEqual({n:1})
 }
 const marker={};expect(()=>receiveDelta(pair.b,{kind:'delta',values:[marker],objects:[],ids:[],references:[marker],refIds:[999999]},cells(pair.target),pair.write)).toThrow('Missing destination counterpart')
})

function sendInitial(graph:ReturnType<typeof liveProofs>,roots:Root[],port:Pick<MessagePort,'postMessage'>){const capture=captureRoots(graph,roots,true);return {ok:capture.skipped.length===0,...postInitial(graph,capture,port)}}
function sendDelta(graph:ReturnType<typeof liveProofs>,roots:Root[],port:Pick<MessagePort,'postMessage'>,dirty:number[]=[]){const capture=captureRoots(graph,roots,false);if(capture.skipped.length!==0)throw Error('Invalid source type');return postDelta(graph,capture,port,dirty)}

function receiveInitial(graph:ReturnType<typeof liveProofs>,packet:Initial,roots:Root[],writer:ReturnType<typeof nativeWriter>){return restoreInitial(graph,packet,roots.map(root=>({...root,kind:'ref'})),writer)}
function receiveDelta(graph:ReturnType<typeof liveProofs>,packet:Delta,roots:Root[],writer:ReturnType<typeof nativeWriter>){return restoreDelta(graph,packet,roots.map(root=>({...root,kind:'ref'})),writer)}
