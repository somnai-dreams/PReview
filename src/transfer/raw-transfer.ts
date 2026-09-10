import type { Schema, Value } from '../values'
import { liveProofs } from './live-proofs'
import { container, data, validate, type Proofs } from './validate'
import type { Capture } from './capture-roots'

type Graph=ReturnType<typeof liveProofs>
export type Root={schema:Schema;value:unknown}
export type Destination=Root&{kind:'ref'|'state'}
export type Initial={kind:'initial';values:Value[];objects:object[];ids:Float64Array}
// Capture the real clone in this synchronous call. Returning a live packet for
// later serialization would allow application writes to change the checkpoint.
export function initialPacket(graph:Graph,values:Value[]):Initial{
 const objects:object[]=[],ids=new Float64Array(graph.stats().objects)
 let i=0
 for(const entry of graph.entries()){objects.push(entry.value);ids[i++]=entry.id}
 return {kind:'initial',values,objects,ids}
}
export function sendInitial(graph:Graph,capture:Capture,port:Pick<MessagePort,'postMessage'>){
 const start=performance.now(),packet=initialPacket(graph,capture.values)
 const ready=performance.now();port.postMessage(packet)
 return {objects:packet.objects.length,validationMs:capture.validationMs,tableMs:ready-start,sendMs:performance.now()-ready}
}

function mutable(value:object){
 if(!Object.isExtensible(value))return false
 for(const key of Reflect.ownKeys(value)){
  if(typeof key!=='string')return false
  const field=Object.getOwnPropertyDescriptor(value,key)!
  if(!('value'in field)||!field.writable||!field.enumerable&&!(Array.isArray(value)&&key==='length')||!field.configurable&&!(Array.isArray(value)&&key==='length'))return false
 }
 return true
}
function kind(value:object){
 const prototype=Object.getPrototypeOf(value)
 if(prototype===Array.prototype)return 'array'
 if(prototype===Map.prototype)return 'map'
 if(prototype===Set.prototype)return 'set'
 if(prototype===Object.prototype)return 'object'
 throw Error('Unsupported container')
}

// Reconcile a complete native graph while preserving compatible destination
// aliases. The session owns acknowledgements and subsequent React application.
export function receiveInitial(graph:Graph,packet:Initial,roots:Destination[],write:ReturnType<typeof nativeWriter>,preserveInput=false){
 const start=performance.now()
 if(packet.kind!=='initial'||!(packet.ids instanceof Float64Array)||packet.values.length!==roots.length||packet.objects.length!==packet.ids.length)throw Error('Invalid initial packet')
 const sortedIds=packet.ids.slice().sort()
 // The packet keeps its original object/ID order. A temporary packed index
 // checks uniqueness and reservations without a boxed number Set per object.
 for(let i=0;i<sortedIds.length;i++)if(!graph.acceptsIdentity(sortedIds[i]!)||i>0&&sortedIds[i]===sortedIds[i-1])throw Error('Invalid identity table')
 function hasIdentity(id:number){
  let low=0,high=sortedIds.length-1
  if(high<0||id<sortedIds[0]!||id>sortedIds[high]!)return false
  while(low<=high){const middle=Math.floor((low+high)/2),value=sortedIds[middle]!;if(value===id)return true;if(value<id)low=middle+1;else high=middle-1}
  return false
 }
 for(const object of packet.objects)if(!container(object))throw Error('Invalid identity table')
 // Check the existing data, but do not build a second correspondence graph for
 // values that this transfer is about to replace. These proofs last one call.
 const currentData=new WeakMap<object,number>(),currentTypes=new Map<Schema,Map<number,WeakMap<object,number>>>()
 const currentProofs:Proofs={identity:value=>value,read:value=>value,
  known(schema,value,id){return schema.nodes[id]?.kind==='data'?currentData.get(value):currentTypes.get(schema)?.get(id)?.get(value)},
  remember(schema,value,id,height){
   const prior=currentData.get(value);currentData.set(value,prior===undefined?height:Math.min(prior,height))
   if(schema.nodes[id]?.kind==='data')return
   let types=currentTypes.get(schema);if(types===undefined){types=new Map();currentTypes.set(schema,types)}
   let values=types.get(id);if(values===undefined){values=new WeakMap();types.set(id,values)}
   values.set(value,height)
  },
 }
 const claimed=new Set<object>()
 const phase=graph.beginNative(packet.objects,packet.ids,(source,candidate,id)=>{
  const old=graph.find(id)??candidate
  const owner=container(old)?graph.identity(old):undefined
  const reserved=owner!==undefined&&owner!==id&&hasIdentity(owner)
  let target:object
  if(container(old)&&currentData.has(old)&&!reserved&&Object.getPrototypeOf(old)===Object.getPrototypeOf(source)&&!claimed.has(old)&&mutable(old)){target=old;claimed.add(old)}
  else if(!preserveInput)target=source
  else switch(Object.getPrototypeOf(source)){
   case Array.prototype:target=[];break
   case Map.prototype:target=new Map();break
   case Set.prototype:target=new Set();break
   default:target={};break
  }
  // Only existing candidates can be claimed twice. Every incoming object is
  // unique, and newly allocated targets are outside the current-data graph.
  return target
 })
 const tableAt=performance.now()
 try {
 const candidates:unknown[]=[]
 for(const root of roots){
  const valid=validate(root.kind==='ref'?root.schema:data,root.value,currentProofs)
  if(!valid&&root.kind==='ref')return {ok:false as const,reason:'destination-type'}
  candidates.push(valid?root.value:undefined)
 }
 const currentAt=performance.now()
 for(let i=0;i<roots.length;i++)if(!phase.accepts(roots[i]!.schema,packet.values[i],candidates[i])){phase.abort();return {ok:false as const,reason:'incoming-type'}}
 const pairs=phase.pairs
 if(pairs.size()!==packet.objects.length)throw Error('Unreachable identity')
 const values=packet.values.map(value=>container(value)?pairs.get(value)!.value as Value:value)
 // Pairing is injective and the complete proposed graph passed destination
 // types. No state write has occurred; conflicting IDs still reject here.
 for(let i=0;i<packet.objects.length;i++){const source=packet.objects[i]!,entry=pairs.get(source)!,old=graph.find(packet.ids[i]!);if(old!==undefined&&old!==entry.value&&currentData.has(old)&&mutable(old)){phase.abort();throw Error('Conflicting identity')}}
 const validated=performance.now()
 const translate=(value:Value):Value=>container(value)?pairs.get(value)!.value as Value:value
 phase.commit(()=>{
  for(const source of packet.objects){
   const entry=pairs.get(source)!
   const target=entry.value
   switch(kind(source)){
    case'array':{const from=source as Value[],to=target as Value[];for(let i=0;i<from.length;i++){const item=translate(from[i]);if(!Object.is(to[i],item))to[i]=item}if(to.length!==from.length)to.length=from.length;break}
    case'map':{const to=target as Map<Value,Value>;if(source===target){for(const[key,value]of to){const item=translate(value);if(item!==value)write.mapSet(to,key,item)}}else{write.mapClear(to);for(const[key,value]of source as Map<Value,Value>)write.mapSet(to,key,translate(value))}break}
    case'set':{const to=target as Set<Value>;let changed=source!==target;for(const value of to)if(translate(value)!==value)changed=true;if(changed){const items=[...source as Set<Value>].map(translate);write.setClear(to);for(const item of items)write.setAdd(to,item)}break}
    case'object':{
     for(const key of Object.keys(target))if(!Object.hasOwn(source,key))write.erase(target,key)
     for(const key of Object.keys(source)){const item=translate(Reflect.get(source,key)),old=Object.getOwnPropertyDescriptor(target,key);if(old===undefined||!Object.is(old.value,item))write.define(target,key,item)}
     break
    }
   }
  }
 })
 const writtenAt=performance.now()
 for(let i=0;i<packet.objects.length;i++)graph.adopt(pairs.get(packet.objects[i]!)!.value,packet.ids[i]!,true)
 graph.keep(values)
 return {ok:true as const,values,objects:pairs.size(),validationMs:validated-start,commitMs:performance.now()-validated,details:{tableMs:tableAt-start,currentMs:currentAt-tableAt,planMs:0,incomingMs:validated-currentAt,writeMs:writtenAt-validated,adoptMs:performance.now()-writtenAt}}
 }finally{phase.close()}
}

// The observer bootstrap must create these capabilities before wrapping native
// mutation methods. Direct writes are already represented by the validated
// plan; secondary application writes still pass through normal observation.
export function nativeWriter(){
 const define=Object.defineProperty,erase=Reflect.deleteProperty,mapSet=Map.prototype.set,mapClear=Map.prototype.clear,setAdd=Set.prototype.add,setClear=Set.prototype.clear
 return {
  define:(value:object,key:string,item:Value)=>define(value,key,{value:item,writable:true,enumerable:true,configurable:true}),
  erase:(value:object,key:string)=>{if(!erase(value,key))throw Error('Unable to delete field')},
  mapSet:(value:Map<Value,Value>,key:Value,item:Value)=>Reflect.apply(mapSet,value,[key,item]),
  mapClear:(value:Map<Value,Value>)=>Reflect.apply(mapClear,value,[]),
  setAdd:(value:Set<Value>,item:Value)=>Reflect.apply(setAdd,value,[item]),
  setClear:(value:Set<Value>)=>Reflect.apply(setClear,value,[]),
 }
}
