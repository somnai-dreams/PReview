import {captureRoots} from './capture-roots'
import {expect,test}from'bun:test'
import{sendInitial as postInitial,receiveInitial as restoreInitial,nativeWriter,type Initial,type Root}from'./raw-transfer'
import{liveProofs}from'./live-proofs'
import{data}from'./validate'
import{observeNativeWrites}from'../native-writes'
import type{Schema,Value}from'../values'
function transmit(values:Value[],target:Value[],schema:Schema=data){
 const a=liveProofs(0),b=liveProofs(1);let packet:Initial|undefined
 const sent=sendInitial(a,values.map(value=>({value,schema})),{postMessage(value:Initial){packet=structuredClone(value)}})
 expect(sent.ok).toBe(true)
 const received=receiveInitial(b,packet!,target.map(value=>({value,schema})),nativeWriter())
 return{a,b,packet:packet!,received}
}
test('native initial payload retains alias identities without normalized field records',()=>{
 const row={n:1},old={n:0},held=old,values=[[row],row]
 const result=transmit(values,[[old],old]);expect(result.received.ok).toBe(true)
 if(!result.received.ok)throw Error('Transfer rejected')
 expect(result.received.values[1]).toBe(held);expect(held.n).toBe(1)
 expect((result.received.values[0] as Value[])[0]).toBe(held)
 expect(result.packet.objects.length).toBe(2);expect(result.packet.ids).toBeInstanceOf(Float64Array)
 expect(Object.keys(result.packet)).toEqual(['kind','values','objects','ids'])
 expect(result.packet.objects).toContain(result.packet.values[1] as object)
})
test('selection remains shared after ordinary Map/Set/array serialization and reconciliation',()=>{
 const row={n:2},other={n:3},result=transmit([new Map([['x',row],['y',other]]),new Set([other,row]),row],[new Map(),new Set(),null])
 expect(result.received.ok).toBe(true);if(!result.received.ok)throw Error('Transfer rejected')
 const[map,set,selected]=result.received.values as[Map<string,Value>,Set<Value>,Value]
 expect(map.get('x')).toBe(selected);expect([...set]).toEqual([{n:3},{n:2}]);expect([...set][1]).toBe(selected)
})
test('serialization finishes before later application writes can change the checkpoint',()=>{
 const graph=liveProofs(0),value={n:1};let packet:Initial|undefined
 sendInitial(graph,[{schema:data,value}],{postMessage(value:Initial){packet=structuredClone(value)}})
 graph.touch(value).n=2
 expect(packet!.values).toEqual([{n:1}]);expect(graph.dirty.size).toBe(1)
})
test('an incompatible declared destination rejects all writes',()=>{
 const schema:Schema={root:0,nodes:[{kind:'object',fields:[{name:'n',shape:1,optional:false}],index:null},{kind:'primitive',name:'number'}]}
 const a=liveProofs(0),b=liveProofs(1),target={n:0};let packet:Initial|undefined
 sendInitial(a,[{schema:data,value:{n:'bad'}}],{postMessage(value:Initial){packet=structuredClone(value)}})
 const result=receiveInitial(b,packet!,[{schema,value:target}],nativeWriter());expect(result.ok).toBe(false);expect(target.n).toBe(0)
})
test('a new wrapper reuses destination proofs after the first transfer',()=>{
 const rows=Array.from({length:10000},(_,n)=>({n})),result=transmit([rows],[[]])
 expect(result.received.ok).toBe(true);if(!result.received.ok)throw Error('Transfer rejected')
 const before=result.b.stats().reads
 expect(result.b.accepts(data,{rows:result.received.values[0]})).toBe(true)
 expect(result.b.stats().reads-before).toBe(1)
})

test('controlled writes preserve proofs while native mutation observation remains installed',()=>{
 const writer=nativeWriter(),a=liveProofs(0),b=liveProofs(1);let packet:Initial|undefined
 const stop=observeNativeWrites(value=>{a.touch(value);b.touch(value);return value})
 try{
  const row={n:1},old={n:0}
  sendInitial(a,[{schema:data,value:new Map([['row',row]])}],{postMessage(value:Initial){packet=structuredClone(value)}})
  const result=receiveInitial(b,packet!,[{schema:data,value:new Map([['row',old]])}],writer)
  expect(result.ok).toBe(true);if(!result.ok)throw Error('Transfer rejected')
  const before=b.stats().reads;expect(b.accepts(data,{wrapped:result.values[0]})).toBe(true);expect(b.stats().reads-before).toBe(1)
  Object.assign(old,{n:2});const after=b.stats().reads;expect(b.accepts(data,result.values[0])).toBe(true);expect(b.stats().reads-after).toBe(2)
 }finally{stop()}
})

test('a missing counterpart uses the native received graph without another object copy',()=>{
 const result=transmit([[{n:1,items:new Set([{n:2}])}]],[null])
 expect(result.received.ok).toBe(true);if(!result.received.ok)throw Error('Transfer rejected')
 expect(result.received.values[0]).toBe(result.packet.values[0])
 const rows=result.received.values[0] as {n:number;items:Set<Value>}[]
 expect(Object.is(rows[0],(result.packet.values[0] as Value[])[0])).toBe(true)
 expect([...rows[0]!.items]).toEqual([{n:2}])
})
test('adopted containers reconnect references to existing destination objects',()=>{
 const source={n:1},destination={n:0},result=transmit([source,{items:new Set([source]),map:new Map([['x',source]])}],[destination,null])
 expect(result.received.ok).toBe(true);if(!result.received.ok)throw Error('Transfer rejected')
 const wrapper=result.received.values[1] as {items:Set<Value>;map:Map<string,Value>}
 expect(Object.is(wrapper,result.packet.values[1])).toBe(true);expect([...wrapper.items][0]).toBe(destination);expect(wrapper.map.get('x')).toBe(destination)
 expect(destination.n).toBe(1)
})
test('planning rejects executable collection properties before invoking them',()=>{
 let reads=0
 const map=new Map();Object.defineProperty(map,Symbol.iterator,{get(){reads++;throw Error('Executed user getter')}})
 const graph=liveProofs(1),target={n:0}
 expect(receiveInitial(graph,{kind:'initial',values:[map],objects:[map],ids:new Float64Array([0])},[{schema:data,value:target}],nativeWriter())).toEqual({ok:false,reason:'incoming-type'})
 expect(target.n).toBe(0);expect(reads).toBe(0)
})
test('after a failed nested schema probe an observed mutation still invalidates a valid ancestor',()=>{
 const graph=liveProofs(0),child={n:1},root={child}
 expect(graph.accepts(data,root)).toBe(true)
 const phase=graph.begin();expect(phase.accepts(data,child)).toBe(true);phase.abort()
 Object.defineProperty(graph.touch(child),'n',{value:()=>0,writable:true,enumerable:true,configurable:true})
 expect(graph.accepts(data,root)).toBe(false)
})

test('a full insertion cannot steal the existing identity of a later row',()=>{
 const row={n:1},source=[row],a=liveProofs(0),b=liveProofs(1),target=[{n:0}],held=target[0]
 function full(){let packet:Initial|undefined;sendInitial(a,[{schema:data,value:source}],{postMessage(value:Initial){packet=structuredClone(value)}});const result=receiveInitial(b,packet!,[{schema:data,value:target}],nativeWriter());expect(result.ok).toBe(true)}
 full();a.touch(source).unshift({n:2});full()
 expect(target).toEqual([{n:2},{n:1}]);expect(target[1]).toBe(held)
})
test('three namespaces can create objects and pass a full graph in every direction',()=>{
 const graphs=[liveProofs(0),liveProofs(1),liveProofs(2)],roots:Value[]=[[{n:1}],[],[]]
 function full(from:number,to:number){let packet:Initial|undefined;sendInitial(graphs[from]!,[{schema:data,value:roots[from]}],{postMessage(value:Initial){packet=structuredClone(value)}});const result=receiveInitial(graphs[to]!,packet!,[{schema:data,value:roots[to]}],nativeWriter());if(!result.ok)throw Error(result.reason);roots[to]=result.values[0]}
 full(0,1);graphs[1]!.touch(roots[1] as Value[]).push({n:2});full(1,2)
 graphs[2]!.touch(roots[2] as Value[]).push({n:3});full(2,0);full(0,1)
 for(const root of roots)expect(root).toEqual([{n:1},{n:2},{n:3}])
 for(const graph of graphs){graph.clear();expect(graph.stats().objects).toBe(0)}
})
test('a peer cannot reserve a future local object identity',()=>{
 const graph=liveProofs(1),source={n:1},target={n:0}
 expect(()=>receiveInitial(graph,{kind:'initial',values:[source],objects:[source],ids:new Float64Array([4294967296])},[{schema:data,value:target}],nativeWriter())).toThrow('Invalid identity table')
 expect(target.n).toBe(0)
 expect(graph.accepts(data,target)).toBe(true);expect(graph.get(target).id).toBe(4294967296)
})
test('native identity validation rejects malformed tables before touching destination values',()=>{
 const first={n:1},second={n:2}
 for(const ids of [[0,0],[0,NaN],[0,Infinity],[0,-1],[0,0.5]]){
  const graph=liveProofs(1),target=[{n:0}]
  expect(()=>receiveInitial(graph,{kind:'initial',values:[first,second],objects:[first,second],ids:new Float64Array(ids)},target.concat({n:0}).map(value=>({schema:data,value})),nativeWriter())).toThrow('Invalid identity table')
  expect(target).toEqual([{n:0}]);expect(graph.stats().objects).toBe(0)
 }
 const graph=liveProofs(1),target={n:0}
 expect(()=>receiveInitial(graph,{kind:'initial',values:[first],objects:[first,second],ids:new Float64Array([3,1])},[{schema:data,value:target}],nativeWriter())).toThrow('Unreachable identity')
 expect(target.n).toBe(0)
})
test('native identity tables need not be ordered and aliases survive reconciliation',()=>{
 const graph=liveProofs(1),other={n:2},source={n:1,next:other}
 const target:{n:number;next?:Value}={n:0}
 const result=receiveInitial(graph,{kind:'initial',values:[source,other],objects:[other,source],ids:new Float64Array([20,3])},[{schema:data,value:target},{schema:data,value:null}],nativeWriter())
 expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason)
 expect(result.values[0]).toBe(target);expect(target.next).toBe(result.values[1]);expect(target).toEqual(source)
 expect(graph.find(3)).toBe(target);expect(graph.find(20)===target.next).toBe(true)
})

function sendInitial(graph:ReturnType<typeof liveProofs>,roots:Root[],port:Pick<MessagePort,'postMessage'>){const capture=captureRoots(graph,roots,true);return {ok:capture.skipped.length===0,...postInitial(graph,capture,port)}}

test('replacing a known readonly graph preserves aliases and releases displaced ownership',()=>{
 const a=liveProofs(0),b=liveProofs(1),row={n:1},source={rows:[row],selected:row}
 let target:typeof source={rows:[],selected:{n:0}}
 function full(){let packet:Initial|undefined;sendInitial(a,[{schema:data,value:source}],{postMessage(value:Initial){packet=structuredClone(value)}});const result=receiveInitial(b,packet!,[{schema:data,value:target}],nativeWriter());if(!result.ok)throw Error(result.reason);target=result.values[0] as typeof target}
 full()
 for(let n=2;n<=100;n++){
  const held=target;Object.freeze(b.touch(held.selected));Object.freeze(b.touch(held.rows));Object.freeze(b.touch(held))
  a.touch(row).n=n;full()
  expect(target).not.toBe(held);expect(held.selected.n).toBe(n-1);expect(target.selected.n).toBe(n)
  expect(target.selected).toBe(target.rows[0]!);expect(b.find(a.get(row).id)).toBe(target.selected)
  expect(b.stats().objects).toBe(3)
 }
 b.clear();expect(b.stats().objects).toBe(0)
})
test('a rejected readonly replacement leaves current identities and values intact',()=>{
 const a=liveProofs(0),b=liveProofs(1),source:{n:Value}={n:1},schema:Schema={root:0,nodes:[{kind:'object',fields:[{name:'n',shape:1,optional:false}],index:null},{kind:'primitive',name:'number'}]}
 let target={n:0};function packet(){let value:Initial|undefined;sendInitial(a,[{schema:data,value:source}],{postMessage(packet:Initial){value=structuredClone(packet)}});return value!}
 const first=receiveInitial(b,packet(),[{schema,value:target}],nativeWriter());if(!first.ok)throw Error(first.reason);target=first.values[0] as typeof target
 Object.freeze(b.touch(target));a.touch(source).n='bad'
 const result=receiveInitial(b,packet(),[{schema,value:target}],nativeWriter())
 expect(result.ok).toBe(false);expect(target.n).toBe(1);expect(b.find(a.get(source).id)).toBe(target);expect(b.stats().objects).toBe(1)
 b.clear();expect(b.stats().objects).toBe(0)
})

function receiveInitial(graph:ReturnType<typeof liveProofs>,packet:Initial,roots:Root[],writer:ReturnType<typeof nativeWriter>){return restoreInitial(graph,packet,roots.map(root=>({...root,kind:'ref'})),writer)}
