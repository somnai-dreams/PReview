import {expect,test} from 'bun:test'
import {liveProofs} from './live-proofs'
import {data} from './validate'
import {nativeWriter} from './raw-transfer'
import {transferSession,type Packet} from './transfer-session'
import type {Value} from '../values'
function replica(site:number,value:Value){
 const graph=liveProofs(site),session=transferSession(graph,'scope-one')
 const state={value,owner:{},observed:true}
 return {graph,session,state,view:()=>[{id:'app/view.tsx:View:state',kind:'ref' as const,schema:data,value:state.value,owner:state.owner}]}
}
type Replica=ReturnType<typeof replica>
function send(a:Replica,b:Replica){
 const offer=b.session.offer(b.view(),b.state.observed);let packet:Packet|undefined
 const sent=a.session.send(offer,a.view(),a.state.observed,{postMessage(value:Packet){packet=structuredClone(value)}})
 return {offer,sent,packet:packet!}
}
function receive(a:Replica,b:Replica,packet:Packet,ack=true){
 const result=b.session.receive(packet,b.view(),b.state.observed,nativeWriter())
 if(result.values!==null)b.state.value=result.values[0]!.value
 if(ack)expect(a.session.acknowledge(result.receipt)).toBe(true)
 return result
}
function transfer(a:Replica,b:Replica){const transfer=send(a,b);expect(receive(a,b,transfer.packet).receipt.outcome).toBe('accepted');return transfer}
test('two builds use deltas, a third build rebases through the ordinary full graph',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0}),c=replica(2,{n:0})
 expect(transfer(a,b).sent.kind).toBe('initial')
 b.graph.touch(b.state.value as {n:number}).n=2;expect(transfer(b,a).sent.kind).toBe('delta')
 expect(transfer(a,c).sent.kind).toBe('initial');c.graph.touch(c.state.value as {n:number}).n=3
 expect(transfer(c,a).sent.kind).toBe('delta');expect(transfer(a,b).sent.kind).toBe('initial')
 for(const item of[a,b,c])expect(item.state.value).toEqual({n:3})
})
test('a nested write after the offer retries before overwriting that write',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0});transfer(a,b)
 const pending=send(a,b);b.graph.touch(b.state.value as {n:number}).n=7
 expect(receive(a,b,pending.packet).receipt.outcome).toBe('retry');expect(b.state.value).toEqual({n:7})
 expect(transfer(a,b).sent.kind).toBe('delta');expect(b.state.value).toEqual({n:1})
})
test('root replacement or remount after the offer retries even without an object write',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0});transfer(a,b)
 let pending=send(a,b);b.state.value={n:9}
 expect(receive(a,b,pending.packet).receipt.outcome).toBe('retry');expect(b.state.value).toEqual({n:9})
 transfer(a,b);pending=send(a,b);b.state.owner={}
 expect(receive(a,b,pending.packet).receipt.outcome).toBe('retry');transfer(a,b)
})
test('a lost acknowledgement forces full resynchronization and stale timers cannot cancel it',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0}),first=send(a,b)
 const applied=receive(a,b,first.packet,false);expect(applied.receipt.outcome).toBe('accepted')
 expect(a.session.cancel(first.sent.id)).toBe(true);expect(a.session.status().base).toBeNull()
 const next=send(a,b);expect(next.sent.kind).toBe('initial')
 expect(a.session.cancel(first.sent.id)).toBe(false);expect(a.session.acknowledge(applied.receipt)).toBe(false)
 expect(a.session.status().phase).toBe('sending');expect(receive(a,b,next.packet).receipt.outcome).toBe('accepted')
})
test('incomplete observation forces fresh full validation and transfers unobserved writes',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0});transfer(a,b)
 ;(a.state.value as {n:number}).n=2;a.state.observed=false
 expect(transfer(a,b).sent.kind).toBe('initial');expect(b.state.value).toEqual({n:2})
 a.state.observed=true;b.state.observed=false;(a.state.value as {n:number}).n=3
 expect(transfer(a,b).sent.kind).toBe('initial');expect(b.state.value).toEqual({n:3})
})
test('observation lost after the offer cannot accept a delta',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0});transfer(a,b)
 const pending=send(a,b);b.state.observed=false
 expect(receive(a,b,pending.packet).receipt.outcome).toBe('retry');expect(transfer(a,b).sent.kind).toBe('initial')
})
test('wrong-scope packets and receipts cannot end or alter a pending exchange',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0}),pending=send(a,b)
 expect(()=>b.session.receive({...pending.packet,scope:'other'},b.view(),true,nativeWriter())).toThrow('Unexpected transfer packet')
 expect(b.session.status().phase).toBe('offering');expect(b.state.value).toEqual({n:0})
 expect(a.session.acknowledge({scope:'other',id:pending.sent.id,offer:pending.offer.id,outcome:'accepted'})).toBe(false)
 expect(a.session.status().phase).toBe('sending');expect(receive(a,b,pending.packet).receipt.outcome).toBe('accepted')
})
test('post-capture writes survive the initial acknowledgement',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0}),offer=b.session.offer(b.view(),true);let packet:Packet|undefined
 const result=a.session.send(offer,a.view(),true,{postMessage(value:Packet){packet=structuredClone(value);a.graph.touch(a.state.value as {n:number}).n=2}})
 expect(result.id).toBeString();expect(receive(a,b,packet!).receipt.outcome).toBe('accepted');expect(b.state.value).toEqual({n:1})
 transfer(a,b);expect(b.state.value).toEqual({n:2})
})
test('a missing requested counterpart selects full transfer before posting any delta',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0});transfer(a,b)
 const offer=b.session.offer(b.view(),true);offer.dirty.push(999999);let packet:Packet|undefined
 const result=a.session.send(offer,a.view(),true,{postMessage(value:Packet){packet=structuredClone(value)}})
 expect(result.kind).toBe('initial');expect(receive(a,b,packet!).receipt.outcome).toBe('accepted')
})
test('rejected input closes the exchange and forces a fresh baseline',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0});transfer(a,b);const pending=send(a,b)
 if(pending.packet.data.kind!=='delta')throw Error('Expected delta')
 pending.packet.data.refIds[0]=999999
 expect(receive(a,b,pending.packet).receipt.outcome).toBe('rejected');expect(b.session.status()).toEqual({base:null,phase:'idle'});expect(b.state.value).toEqual({n:1})
 expect(transfer(a,b).sent.kind).toBe('initial')
})

test('capture and application writes cannot reenter the protocol owner',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0}),offer=b.session.offer(b.view(),true);let packet:Packet|undefined
 const sent=a.session.send(offer,a.view(),true,{postMessage(value:Packet){expect(()=>a.session.offer(a.view(),true)).toThrow('Transfer already in progress');packet=structuredClone(value)}})
 expect(sent.id).toBeString()
 const writer=nativeWriter(),result=b.session.receive(packet!,b.view(),true,{...writer,define(value,key,item){expect(()=>b.session.offer(b.view(),true)).toThrow('Transfer already in progress');return writer.define(value,key,item)}})
 expect(result.receipt.outcome).toBe('accepted');expect(a.session.acknowledge(result.receipt)).toBe(true)
})
test('failed serialization releases the protocol owner and permits a full retry',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0}),offer=b.session.offer(b.view(),true)
 expect(()=>a.session.send(offer,a.view(),true,{postMessage(){throw Error('Transport failed')}})).toThrow('Transport failed')
 expect(a.session.status()).toEqual({base:null,phase:'idle'});expect(b.session.cancel(offer.id)).toBe(true)
 expect(transfer(a,b).sent.kind).toBe('initial')
})

test('cell names survive different order, added cells, missing owners and unsupported refs',()=>{
 const a=liveProofs(0),b=liveProofs(1),source=transferSession(a,'names'),target=transferSession(b,'names'),owner={}
 const cell=(id:string,value:unknown,kind:'ref'|'state'='ref')=>({id,value,kind,schema:data,owner})
 let getters=0
 const bad=Object.defineProperty({prefix:{n:9}},'resource',{enumerable:true,get(){getters++;throw Error('Must not read getter')}})
 const shared={n:1},left=[cell('feed',[shared]),cell('selection',shared),cell('new-page','open','state'),cell('handle',bad),cell('duplicates',1),cell('duplicates',2),cell('excluded',{n:8})]
 const held={n:0},right=[cell('selection',held),cell('unrelated',{local:1}),cell('feed',[held]),cell('handle',bad),cell('excluded',{n:0}),cell('excluded',{n:0})]
 let packet:Packet|undefined
 const sent=source.send(target.offer(right,true),left,true,{postMessage(value:Packet){packet=structuredClone(value)}})
 expect(sent.skipped).toEqual([{id:'duplicates',reason:'source-ambiguous'},{id:'excluded',reason:'destination-ambiguous'},{id:'handle',reason:'unsupported'}])
 expect(packet!.names.map(cell=>cell.id)).toEqual(['feed','selection','new-page'])
 expect(packet!.data.objects).toHaveLength(2);expect(a.stats().objects).toBe(2)
 const result=target.receive(packet!,right,true,nativeWriter());expect(result.receipt.outcome).toBe('accepted');expect(result.absent).toEqual(['new-page'])
 expect(result.values?.find(cell=>cell.id==='selection')?.value).toBe(held);expect(held.n).toBe(1)
 const feed=result.values?.find(cell=>cell.id==='feed')?.value
 if(!Array.isArray(feed))throw Error('Expected a transferred feed')
 expect(feed[0]).toBe(held)
 expect(right[1]!.value).toEqual({local:1});expect(right[4]!.value).toEqual({n:0});expect(getters).toBe(0)
 expect(source.acknowledge(result.receipt)).toBe(true)
})
test('a skipped root releases its checked prefix but retains a separately accepted shared child',()=>{
 const graph=liveProofs(0),destination=liveProofs(1),a=transferSession(graph,'capture'),b=transferSession(destination,'capture'),owner={},shared={n:1}
 const roots=[{id:'invalid',kind:'ref' as const,schema:data,value:{prefix:{unique:1},shared,bad:()=>0},owner},{id:'valid',kind:'ref' as const,schema:data,value:{shared},owner}]
 let packet:Packet|undefined
 a.send(b.offer([],true),roots,true,{postMessage(value:Packet){packet=structuredClone(value)}})
 expect(graph.stats().objects).toBe(2);expect(packet!.data.objects).toHaveLength(2)
 const received=b.receive(packet!,[],true,nativeWriter());expect(received.receipt.outcome).toBe('accepted');expect(received.values?.[0]?.value).toEqual({shared:{n:1}})
})
test('a full transfer to another peer reuses proofs but includes all owned identities',()=>{
 const a=replica(0,{rows:Array.from({length:1000},(_,n)=>({n}))}),b=replica(1,null),c=replica(2,null)
 transfer(a,b);const before=a.graph.stats().reads,next=transfer(a,c)
 expect(next.sent.kind).toBe('initial');expect(next.packet.data.objects).toHaveLength(1002)
 expect(a.graph.stats().reads-before).toBe(0);expect(c.state.value).toEqual(a.state.value)
})
test('transport selection follows pruning a requested object out of the accepted source roots',()=>{
 const a=replica(0,{row:{n:1}}),b=replica(1,{row:{n:0}});transfer(a,b)
 const row=(b.state.value as {row:{n:number}}).row;b.graph.touch(row).n=7
 a.state.value={replacement:1}
 const next=transfer(a,b);expect(next.sent.kind).toBe('initial');expect(b.state.value).toEqual({replacement:1})
})
test('kind changes and duplicate packet names reject before any destination writes',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0}),pending=send(a,b)
 pending.packet.names[0]!.kind='state'
 expect(receive(a,b,pending.packet).receipt.outcome).toBe('rejected');expect(b.state.value).toEqual({n:0})
 const duplicate=send(a,b);duplicate.packet.names.push(duplicate.packet.names[0]!);duplicate.packet.data.values.push(duplicate.packet.data.values[0])
 expect(receive(a,b,duplicate.packet).receipt.outcome).toBe('rejected');expect(b.state.value).toEqual({n:0})
})
test('losing observation forces fresh validation and skips a now unsupported root',()=>{
 const a=replica(0,{n:1}),b=replica(1,{n:0});transfer(a,b)
 Object.defineProperty(a.state.value,'n',{value:()=>0,enumerable:true,writable:true,configurable:true});a.state.observed=false
 const pending=send(a,b);expect(pending.sent.skipped).toEqual([{id:'app/view.tsx:View:state',reason:'unsupported'}])
 const result=b.session.receive(pending.packet,b.view(),true,nativeWriter());expect(result.receipt.outcome).toBe('accepted');expect(result.values).toEqual([]);expect(b.state.value).toEqual({n:1})
 expect(a.graph.stats().objects).toBe(0)
})

test('a readonly delta requests full before writing and the full retry replaces all aliases',()=>{
 const row={n:1},a=replica(0,{rows:[row],selected:row}),b=replica(1,{rows:[],selected:null})
 transfer(a,b)
 const before=b.state.value as {rows:{n:number}[];selected:{n:number}},held=before.selected
 Object.freeze(b.graph.touch(held));a.graph.touch(row).n=2
 const pending=send(a,b);expect(pending.sent.kind).toBe('delta')
 const result=receive(a,b,pending.packet);expect(result.receipt.outcome).toBe('rejected');expect(result.retry).toBe('full')
 expect(held.n).toBe(1);expect(before.selected).toBe(held)
 const next=transfer(a,b);expect(next.sent.kind).toBe('initial')
 const after=b.state.value as typeof before;expect(after.selected).not.toBe(held);expect(after.selected.n).toBe(2);expect(after.selected).toBe(after.rows[0]!)
 expect(b.graph.stats().objects).toBe(3)
})

test('unobserved structural edits rebuild ownership before collecting a full identity table',()=>{
 const a=replica(0,{rows:[{n:1}],other:null}),b=replica(1,null);transfer(a,b)
 const root=a.state.value as {rows:{n:number}[];other:{n:number}|null}
 root.rows.push({n:2});root.other=root.rows[1]!
 a.state.observed=false
 const next=transfer(a,b);expect(next.sent.kind).toBe('initial');expect(next.packet.data.objects).toHaveLength(4)
 const target=b.state.value as typeof root;expect(target.rows).toEqual([{n:1},{n:2}]);expect(target.other).toBe(target.rows[1]!)
 root.rows.splice(0,1);transfer(a,b);expect(a.graph.stats().objects).toBe(3)
})

test('bulk growth and replacement use the native graph while a later small edit stays incremental',()=>{
 const rows=[{n:0}],a=replica(0,rows),b=replica(1,[{n:9}]);transfer(a,b)
 a.graph.touch(rows);for(let n=1;n<5000;n++)rows.push({n})
 const grown=transfer(a,b);expect(grown.sent.kind).toBe('initial');expect(b.state.value).toEqual(rows)
 expect(a.graph.stats().unshared).toBe(0);expect(b.graph.stats().unshared).toBe(0)
 a.graph.touch(rows[4999]!).n=42
 const edit=transfer(a,b);expect(edit.sent.kind).toBe('delta');expect(edit.packet.data.objects).toHaveLength(1);expect(b.state.value).toEqual(rows)
 a.state.value=Array.from({length:5000},(_,n)=>({n:n+1}))
 const replacement=transfer(a,b);expect(replacement.sent.kind).toBe('initial');expect(b.state.value).toEqual(a.state.value)
 expect(a.graph.stats().unshared).toBe(0);expect(b.graph.stats().unshared).toBe(0)
})

test('unshared counts survive rejected serialization, pruning and readonly replacement',()=>{
 const graph=liveProofs(0),old=Object.freeze({n:1}),root={old};graph.accepts(data,root);expect(graph.stats().unshared).toBe(2);graph.share()
 const replacement={n:1};graph.adopt(replacement,graph.identity(old)!,true);expect(graph.stats().unshared).toBe(2)
 graph.keep([replacement]);expect(graph.stats().objects).toBe(1);expect(graph.stats().unshared).toBe(1);graph.share();graph.clear();expect(graph.stats().unshared).toBe(0)
 const a=replica(0,[{n:0}]),b=replica(1,[]);transfer(a,b)
 a.state.value=Array.from({length:5000},(_,n)=>({n}));const offer=b.session.offer(b.view(),true)
 expect(()=>a.session.send(offer,a.view(),true,{postMessage(){throw Error('closed')}})).toThrow('closed')
 expect(a.graph.stats().unshared).toBe(5001);b.session.cancel(offer.id)
 expect(transfer(a,b).sent.kind).toBe('initial');expect(a.graph.stats().unshared).toBe(0)
})
