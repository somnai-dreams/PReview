import type { Value } from '../values'
import type { Entry, liveProofs } from './live-proofs'
import { container, data } from './validate'
import { nativeWriter, type Destination } from './raw-transfer'
import type { Capture } from './capture-roots'

type Graph=ReturnType<typeof liveProofs>
export type Delta={kind:'delta';values:Value[];objects:object[];ids:number[];references:object[];refIds:number[]}
// This codec requires an acknowledged common baseline. A caller must serialize
// transfers, compare the baseline/receiver revision, and fall back to full when
// it cannot prove that prerequisite. It is not the runtime session protocol.
export function sendDelta(graph:Graph,capture:Capture,port:Pick<MessagePort,'postMessage'>,remoteDirty:number[]=[]){
  const sent:Entry[]=[],values=capture.values
  const dirty=new Set(graph.dirty),requested=new Set(dirty)
  for(const id of remoteDirty){const value=graph.find(id);if(value===undefined)throw Error('Missing source counterpart');requested.add(graph.get(value))}
  const packet:Delta={kind:'delta',values:[],objects:[],ids:[],references:[],refIds:[]},copies=new Map<object,Value>(),markers=new Map<Entry,object>()
  function encode(value:Value):Value{
   if(!container(value))return value
   const entry=graph.get(value)
   if(!entry.shared)return body(value)
   let marker=markers.get(entry)
   if(marker===undefined){marker={};markers.set(entry,marker);packet.references.push(marker);packet.refIds.push(entry.id)}
   return marker as Value
  }
  function body(value:object):Value{
   const prior=copies.get(value);if(prior!==undefined)return prior
   const entry=graph.get(value);let target:Value
   if(Array.isArray(value))target=[]
   else if(value instanceof Map)target=new Map()
   else if(value instanceof Set)target=new Set()
   else target={}
   copies.set(value,target);packet.objects.push(target);packet.ids.push(entry.id);sent.push(entry)
   if(Array.isArray(value)){for(const item of value)(target as Value[]).push(encode(item))}
   else if(value instanceof Map){for(const[key,item]of value)(target as Map<Value,Value>).set(key,encode(item))}
   else if(value instanceof Set){for(const item of value)(target as Set<Value>).add(encode(item))}
   else for(const key of Object.keys(value))Object.defineProperty(target,key,{value:encode(Object.getOwnPropertyDescriptor(value,key)!.value),enumerable:true,writable:true,configurable:true})
   return target
  }
  packet.values=values.map(encode)
  for(const entry of requested)body(entry.value)
  // Coalesce writes made after serialization separately from these captured
  // writes. An unsuccessful acknowledgement restores this set for retry.
  for(const entry of dirty)graph.dirty.delete(entry)
  try{port.postMessage(packet)}catch(error){for(const entry of dirty)graph.dirty.add(entry);throw error}
  let acknowledged=false
  return {objects:packet.objects.length,references:packet.references.length,
   acknowledge(ok:boolean){if(acknowledged)throw Error('Already acknowledged');acknowledged=true;if(ok)for(const entry of sent)graph.shareEntry(entry);else for(const entry of dirty)graph.dirty.add(entry)},
  }
}

export function receiveDelta(graph:Graph,packet:Delta,roots:Destination[],write:ReturnType<typeof nativeWriter>){
 if(packet.kind!=='delta'||packet.values.length!==roots.length||packet.objects.length!==packet.ids.length||packet.references.length!==packet.refIds.length)throw Error('Invalid delta')
 const incoming=new Map<object,number>(),bodies=new Map<number,object>(),references=new Map<object,number>()
 for(let i=0;i<packet.ids.length;i++){
  const value=packet.objects[i]!,id=packet.ids[i]!
  if(!container(value)||!graph.acceptsIdentity(id)||incoming.has(value)||bodies.has(id))throw Error('Invalid identity table')
  incoming.set(value,id);bodies.set(id,value)
 }
 for(let i=0;i<packet.refIds.length;i++){
  const marker=packet.references[i]!,id=packet.refIds[i]!
  if(!container(marker)||Object.getPrototypeOf(marker)!==Object.prototype||Reflect.ownKeys(marker).length!==0||!graph.acceptsIdentity(id)||incoming.has(marker)||references.has(marker))throw Error('Invalid reference')
  references.set(marker,id)
 }
 // Reuse existing proofs for the live-ref boundary. Temporary roots retain
 // their explicit owners until the validated write plan replaces them.
 const check=graph.begin()
 try{for(const root of roots)if(root.kind==='ref'&&!check.accepts(root.schema,root.value))throw Error('Invalid destination type');check.commit()}finally{check.close()}
 const pairs=new Map<object,object>(),claimed=new Set<object>(),resolved=new Map<object,object>()
 let depth=0,requiresFull=false
 function translate(value:Value):Value{
  if(!container(value))return value
  const id=references.get(value)
  if(id!==undefined){
   const prior=resolved.get(value);if(prior!==undefined)return prior as Value
   const body=bodies.get(id),target=body===undefined?graph.find(id):plan(body)
   if(target===undefined)throw Error('Missing destination counterpart')
   resolved.set(value,target);return target as Value
  }
  return plan(value) as Value
 }
 function plan(source:object):object{
  const ready=pairs.get(source);if(ready!==undefined)return ready
  if(depth>=100)throw Error('Delta too deep')
  const id=incoming.get(source);if(id===undefined)throw Error('Missing body identity')
  const target=graph.find(id)??source
  if(claimed.has(target)||Object.getPrototypeOf(source)!==Object.getPrototypeOf(target))throw Error('Conflicting body identity')
  if(target!==source){
   if(!Object.isExtensible(target))requiresFull=true
   if((target instanceof Map||target instanceof Set)&&Reflect.ownKeys(target).length!==0||Array.isArray(target)&&Reflect.ownKeys(target).length!==target.length+1)requiresFull=true
   for(const key of Reflect.ownKeys(target)){const field=Object.getOwnPropertyDescriptor(target,key)!;if(typeof key!=='string'||!('value'in field)||!field.writable||!field.configurable&&!(Array.isArray(target)&&key==='length'))requiresFull=true}
  }
  pairs.set(source,target);claimed.add(target);depth++
  if(source instanceof Map){if(Object.getPrototypeOf(source)!==Map.prototype||Reflect.ownKeys(source).length!==0)throw Error('Unsupported Map');for(const[key,item]of source){if(container(key))throw Error('Object Map key');translate(item)}}
  else if(source instanceof Set){if(Object.getPrototypeOf(source)!==Set.prototype||Reflect.ownKeys(source).length!==0)throw Error('Unsupported Set');for(const item of source)translate(item)}
  else {
   if(Object.getPrototypeOf(source)!==(Array.isArray(source)?Array.prototype:Object.prototype))throw Error('Unsupported body')
   for(const key of Reflect.ownKeys(source)){
    if(Array.isArray(source)&&key==='length')continue
    const field=Object.getOwnPropertyDescriptor(source,key)!
    if(typeof key!=='string'||!('value'in field)||!field.enumerable)throw Error('Executable or hidden body')
    translate(field.value)
   }
  }
  depth--;return target
 }
 const values=packet.values.map(translate)
 for(const source of packet.objects)plan(source)
 if(requiresFull)return {ok:false as const,reason:'readonly-counterpart' as const}
 const overrides=new Map<object,object>()
 for(const[source,target]of pairs)overrides.set(target,source)
 const identities={get:(value:object)=>resolved.get(value)??pairs.get(value)}
 const phase=graph.begin(overrides,false,identities,value=>incoming.get(overrides.get(value)??value))
 try{
  for(let i=0;i<roots.length;i++)if(!phase.accepts(roots[i]!.schema,values[i]))throw Error('Invalid incoming type')
  for(const target of pairs.values())if(!phase.accepts(data,target))throw Error('Invalid incoming data')
  phase.commit(()=>{
   for(const[source,target]of pairs){
    if(Array.isArray(source)){const to=target as Value[];for(let i=0;i<source.length;i++)to[i]=translate(source[i]);to.length=source.length}
    else if(source instanceof Map){const items=[...source].map(([key,item])=>[key,translate(item)] as const);write.mapClear(target as Map<Value,Value>);for(const[key,item]of items)write.mapSet(target as Map<Value,Value>,key,item)}
    else if(source instanceof Set){const items=[...source].map(translate);write.setClear(target as Set<Value>);for(const item of items)write.setAdd(target as Set<Value>,item)}
    else{for(const key of Object.keys(target))if(!Object.hasOwn(source,key))write.erase(target,key);for(const key of Object.keys(source))write.define(target,key,translate(Object.getOwnPropertyDescriptor(source,key)!.value))}
   }
  })
  for(const[source,target]of pairs){const entry=graph.adopt(target,incoming.get(source)!);graph.shareEntry(entry);graph.dirty.delete(entry)}
  graph.keep(values)
  return {ok:true as const,values,objects:pairs.size}
 }finally{phase.close()}
}
