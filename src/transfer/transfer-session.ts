import {sendInitial,receiveInitial,nativeWriter,type Initial,type Root,type Destination} from './raw-transfer'
import {sendDelta,receiveDelta,type Delta} from './delta-transfer'
import {captureRoots} from './capture-roots'
import {data} from './validate'
import type {liveProofs} from './live-proofs'
import type { Value } from '../values'

type Graph=ReturnType<typeof liveProofs>
export type Cell=Root&{id:string;kind:'state'|'ref';owner:object}
export type View=Cell[]
type Name=Pick<Cell,'id'|'kind'>
export type RestoredCell=Name&{value:Value;schema:Root['schema'];changed:boolean}
export type Offer={scope:string;id:string;base:string|null;observed:boolean;dirty:number[];excluded:string[]}
export type Packet={scope:string;offer:string;id:string;base:string|null;names:Name[];data:Initial|Delta}
export type Receipt={scope:string;offer:string;id:string;outcome:'accepted'|'rejected'|'retry'}
type Stamp=Name&{value:unknown;nodes:Root['schema']['nodes'];shape:number;owner:object}
type Phase={kind:'idle'|'capturing'|'applying'}|{kind:'offering';id:string;observed:boolean;revision:number;roots:Stamp[]}|{kind:'sending';id:string;offer:string;finish:(accepted:boolean)=>void}
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128
const cellId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=4096
function offerBoundary(value:Offer,scope:string){
 if(value===null||typeof value!=='object'||value.scope!==scope||!text(value.id)||!(value.base===null||text(value.base))||typeof value.observed!=='boolean'||!Array.isArray(value.dirty)||value.dirty.some(id=>!Number.isSafeInteger(id)||id<0)||!Array.isArray(value.excluded)||value.excluded.some(id=>!cellId(id)))throw Error('Invalid transfer offer')
}
function index(view:View){
 const cells=new Map<string,Cell|null>()
 for(const cell of view){if(!cellId(cell.id)||!(cell.kind==='state'||cell.kind==='ref'))throw Error('Invalid registered cell');cells.set(cell.id,cells.has(cell.id)?null:cell)}
 return cells
}

// One owner serializes incoming/outgoing transfers for a loaded build. The
// scope belongs to the reviewer incarnation; each loaded build must also have
// a distinct numeric object namespace in its graph. Native account checks and
// the parent/origin/MessageChannel boundary remain outside this data protocol.
export function transferSession(graph:Graph,scope:string){
 if(!text(scope))throw Error('Invalid comparison scope')
 let base:string|null=null,phase:Phase={kind:'idle'}
 function offer(view:View,observed:boolean):Offer{
  if(phase.kind!=='idle')throw Error('Transfer already in progress')
  const excluded:string[]=[]
  for(const[id,cell]of index(view))if(cell===null)excluded.push(id)
  const value:Offer={scope,id:crypto.randomUUID(),base,observed,dirty:[...graph.dirty].map(entry=>entry.id),excluded}
  phase={kind:'offering',id:value.id,observed,revision:graph.revision(),roots:view.map(cell=>({id:cell.id,kind:cell.kind,value:cell.value,nodes:cell.schema.nodes,shape:cell.schema.root,owner:cell.owner}))}
  return value
 }
 function send(remote:Offer,view:View,observed:boolean,port:Pick<MessagePort,'postMessage'>){
  if(phase.kind!=='idle')throw Error('Transfer already in progress')
  offerBoundary(remote,scope)
  phase={kind:'capturing'}
  try{
   const candidates:Cell[]=[],skipped:{id:string;reason:'source-ambiguous'|'destination-ambiguous'|'unsupported'}[]=[],excluded=new Set(remote.excluded)
   for(const[id,cell]of index(view)){
    if(cell===null)skipped.push({id,reason:'source-ambiguous'})
    else if(excluded.has(id))skipped.push({id,reason:'destination-ambiguous'})
    else candidates.push(cell)
   }
   // Capture once, then choose transport from the graph that remains owned.
   // A full wire transfer to a third build can reuse valid source proofs. Lost
   // observation requires fresh validation even if another peer has a base.
   const capture=captureRoots(graph,candidates,!observed)
   for(const i of capture.skipped)skipped.push({id:candidates[i]!.id,reason:'unsupported'})
   const names=capture.indices.map(i=>({id:candidates[i]!.id,kind:candidates[i]!.kind}))
   const id=crypto.randomUUID(),full=!observed||!remote.observed||base===null||base!==remote.base||remote.dirty.some(id=>graph.find(id)===undefined)
   const sendPort={postMessage(data:Initial|Delta){port.postMessage({scope,offer:remote.id,id,base:full?null:base,names,data} satisfies Packet)}}
   let finish:(accepted:boolean)=>void
   if(full){
    const dirty=new Set(graph.dirty);graph.dirty.clear()
    const undo=()=>{for(const entry of dirty)if(graph.find(entry.id)===entry.value)graph.dirty.add(entry)}
    try{sendInitial(graph,capture,sendPort)}catch(error){undo();throw error}
    finish=accepted=>{if(accepted)graph.share();else undo()}
   }else finish=sendDelta(graph,capture,sendPort,remote.dirty).acknowledge
   phase={kind:'sending',id,offer:remote.id,finish}
   return {id,kind:full?'initial' as const:'delta' as const,skipped}
  }catch(error){base=null;phase={kind:'idle'};throw error}
 }
 function receive<T>(packet:Packet,view:View,observed:boolean,write:ReturnType<typeof nativeWriter>,apply?:(values:RestoredCell[])=>{ok:boolean;result:T;retry?:'full'}){
  if(phase.kind!=='offering')throw Error('No transfer offer is pending')
  if(packet===null||typeof packet!=='object'||packet.scope!==scope||packet.offer!==phase.id||!text(packet.id)||!(packet.base===null||text(packet.base))||packet.data===null||typeof packet.data!=='object'||!(packet.data.kind==='initial'||packet.data.kind==='delta'))throw Error('Unexpected transfer packet')
  const pending=phase
  const receipt=(outcome:Receipt['outcome']):Receipt=>({scope,offer:packet.offer,id:packet.id,outcome})
  const sameRoots=pending.roots.length===view.length&&pending.roots.every((root,i)=>{const next=view[i]!;return root.id===next.id&&root.kind===next.kind&&root.owner===next.owner&&root.nodes===next.schema.nodes&&root.shape===next.schema.root&&Object.is(root.value,next.value)})
  if(graph.revision()!==pending.revision||!sameRoots||packet.data.kind==='delta'&&(!observed||!pending.observed||packet.base!==base)||packet.data.kind==='initial'&&packet.base!==null){
   phase={kind:'idle'};return {receipt:receipt('retry'),values:null}
  }
  phase={kind:'applying'}
  try{
   if(!Array.isArray(packet.names)||packet.names.length!==packet.data.values.length)throw Error('Invalid named roots')
   const cells=index(view),used=new Set<string>(),roots:Destination[]=[],absent:string[]=[]
   for(const name of packet.names){
    if(name===null||typeof name!=='object'||!cellId(name.id)||!(name.kind==='state'||name.kind==='ref')||used.has(name.id))throw Error('Invalid named root')
    used.add(name.id)
    const cell=cells.get(name.id)
    if(cell===null)throw Error('Ambiguous destination cell')
    if(cell===undefined){roots.push({schema:data,value:undefined,kind:name.kind});absent.push(name.id)}
    else{if(cell.kind!==name.kind)throw Error('Hook kind mismatch');roots.push(cell)}
   }
   const versions=roots.map(root=>graph.version(root.value))
   let values:Value[]
   if(packet.data.kind==='initial'){
    const result=receiveInitial(graph,packet.data,roots,write)
    if(!result.ok){base=null;return {receipt:receipt('rejected'),values:null,error:result.reason}}
    graph.share();values=result.values
   }else{
    const result=receiveDelta(graph,packet.data,roots,write)
    if(!result.ok){base=null;return {receipt:receipt('rejected'),values:null,retry:'full' as const,error:result.reason}}
    values=result.values
   }
   const restored=values.map((value,i)=>({...packet.names[i]!,value,schema:roots[i]!.schema,changed:!Object.is(value,roots[i]!.value)||versions[i]!==graph.version(value)}))
   const completed=apply?.(restored)
   if(completed!==undefined&&!completed.ok){base=null;return {receipt:receipt('rejected'),values:restored,application:completed.result,retry:completed.retry}}
   base=packet.id
   return {receipt:receipt('accepted'),values:restored,absent,application:completed?.result}
  }catch(error){base=null;return {receipt:receipt('rejected'),values:null,error:error instanceof Error?error.message:String(error)}}
  finally{phase={kind:'idle'}}
 }
 function acknowledge(receipt:Receipt){
  if(phase.kind!=='sending'||receipt===null||typeof receipt!=='object'||receipt.scope!==scope||receipt.id!==phase.id||receipt.offer!==phase.offer||!(receipt.outcome==='accepted'||receipt.outcome==='rejected'||receipt.outcome==='retry'))return false
  phase.finish(receipt.outcome==='accepted')
  if(receipt.outcome==='accepted')base=receipt.id
  else if(receipt.outcome==='rejected')base=null
  phase={kind:'idle'};return true
 }
 // A timeout calls cancel with its own request ID. An old timer cannot cancel
 // a newer transfer. After a lost acknowledgement, the next send is full: the
 // receiver may have committed even though the sender never saw its receipt.
 function cancel(id:string){
  switch(phase.kind){
   case'idle':case'capturing':case'applying':return false
   case'offering':if(phase.id!==id)return false;phase={kind:'idle'};return true
   case'sending':if(phase.id!==id)return false;phase.finish(false);base=null;phase={kind:'idle'};return true
  }
 }
 return {offer,send,receive,acknowledge,cancel,status:()=>({base,phase:phase.kind})}
}
