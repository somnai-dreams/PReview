import {expect,test} from 'bun:test'
import {liveProofs} from './live-proofs'
import {data} from './validate'
import {nativeWriter} from './raw-transfer'
import {transferSession,type Packet,type RestoredCell} from './transfer-session'
import {commitCells,type MountedCell,type Application} from './cell-commit'
import type {Value} from '../values'
function cell(id:string,kind:'ref'|'state',initial:Value){
 let value=initial,writes=0
 return {id,kind,schema:data,read:()=>value,stale:()=>false,write(next:Value){value=next;writes++},reset(next:Value){value=next},writes:()=>writes}
}
function setup(left:MountedCell[],right:MountedCell[],effect:(pass:number)=>void=()=>{}){
 const a=liveProofs(0),b=liveProofs(1),source=transferSession(a,'commit'),target=transferSession(b,'commit'),writer=nativeWriter()
 let commits=0,pending:RestoredCell[]|null=null,observed=true
 const app:Application={cells:()=>right,commit(write){write();effect(++commits)},pending(values){pending=values},observed:()=>observed}
 const view=(cells:MountedCell[])=>cells.map(cell=>({id:cell.id,kind:cell.kind,schema:cell.schema,value:cell.read(),owner:cell}))
 function send(){let packet:Packet|undefined;const sent=source.send(target.offer(view(right),true),view(left),true,{postMessage(value:Packet){packet=structuredClone(value)}});return{sent,packet:packet!}}
 function receive(packet:Packet){const result=target.receive(packet,view(right),true,writer,values=>commitCells(b,values,app,writer));source.acknowledge(result.receipt);return result}
 return{a,b,source,target,send,receive,counts:()=>({commits,pending}),loseObservation(){observed=false}}
}
test('repair writes only reset or newly mounted cells and retains settled aliases',()=>{
 const row={title:'saved'},feed=cell('feed','ref',new Map([['one',{title:'old'}]])),draft=cell('draft','state',''),child=cell('child','state',''),selected=cell('selected','state',null),right=[feed,draft,selected]
 const runner=setup([cell('feed','ref',new Map([['one',row]])),cell('draft','state','saved draft'),cell('child','state','saved child'),cell('selected','state',row)],right,pass=>{if(pass===1){draft.reset('reset');selected.reset({title:'saved'});right.push(child)}})
 const result=runner.receive(runner.send().packet)
 expect(result.receipt.outcome).toBe('accepted');expect(result.application?.secondPass).toEqual(['draft','child','selected'])
 expect(feed.writes()).toBe(1);expect(draft.writes()).toBe(2);expect(child.writes()).toBe(1)
 expect(selected.read()).toBe((feed.read() as Map<string,Value>).get('one'));expect(result.application?.changed).toEqual([]);expect(runner.counts()).toEqual({commits:2,pending:null})
})
test('in-place effects repair the shared graph and refresh containing cells',()=>{
 const aRow={n:1},old={n:0},feed=cell('feed','ref',[old]),selected=cell('selected','state',null)
 const runner=setup([cell('feed','ref',[aRow]),cell('selected','state',aRow)],[feed,selected],pass=>{if(pass===1)runner.b.touch(old).n=7})
 const result=runner.receive(runner.send().packet)
 expect(result.receipt.outcome).toBe('accepted');expect(old.n).toBe(1);expect(selected.read()).toBe(old)
 expect(result.application?.secondPass).toEqual(['feed','selected']);expect(result.application?.changed).toEqual([]);expect(result.application).toHaveProperty('journalObjects',1)
})
test('no-change deltas cause no React commit and a leaf edit refreshes its owning cells',()=>{
 const row={n:1},source=cell('feed','ref',[row]),target=cell('feed','ref',[]),runner=setup([source],[target])
 runner.receive(runner.send().packet);expect(runner.counts().commits).toBe(1)
 let sent=runner.send();expect(sent.sent.kind).toBe('delta');let result=runner.receive(sent.packet)
 expect(result.receipt.outcome).toBe('accepted');expect(target.writes()).toBe(1);expect(runner.counts().commits).toBe(1)
 runner.a.touch(row).n=2;sent=runner.send();result=runner.receive(sent.packet)
 expect(result.receipt.outcome).toBe('accepted');expect(target.writes()).toBe(2);expect(runner.counts().commits).toBe(2);expect((target.read() as {n:number}[])[0]!.n).toBe(2)
})
test('persistent effects are reported and their observed drift remains available to the next offer',()=>{
 const old={n:0},target=cell('feed','ref',old),runner=setup([cell('feed','ref',{n:1})],[target],()=>{runner.b.touch(old).n=7})
 const result=runner.receive(runner.send().packet)
 expect(result.receipt.outcome).toBe('accepted');expect(result.application?.changed).toEqual(['feed']);expect(old.n).toBe(7);expect(runner.b.dirty.size).toBe(1)
})
test('observation loss during a commit rejects the baseline and closes pending ownership',()=>{
 const target=cell('draft','state',''),runner=setup([cell('draft','state','saved')],[target],()=>runner.loseObservation())
 const result=runner.receive(runner.send().packet)
 expect(result.receipt.outcome).toBe('rejected');expect(runner.source.status().base).toBeNull();expect(runner.target.status().base).toBeNull();expect(runner.counts().pending).toBeNull()
})
test('new ambiguity during either React commit is reported instead of claiming success',()=>{
 for(const commit of[1,2]){
  const draft=cell('draft','state',''),right=[draft],runner=setup([cell('draft','state','saved')],right,pass=>{if(pass===commit)right.push(cell('draft','state','other'));else draft.reset('effect reset')})
  const result=runner.receive(runner.send().packet)
  expect(result.receipt.outcome).toBe('rejected');expect(result.application?.issues).toContainEqual({id:'draft',reason:'ambiguous'});expect(runner.counts().pending).toBeNull()
 }
})

test('matching data still refreshes a stale rendered view',()=>{
 const source=cell('draft','state','saved'),target=cell('draft','state',''),runner=setup([source],[target])
 runner.receive(runner.send().packet)
 target.stale=()=>true
 const result=runner.receive(runner.send().packet)
 expect(result.receipt.outcome).toBe('accepted');expect(target.writes()).toBeGreaterThan(1)
})
test('a newly mounted incompatible owner after the repair commit is rejected',()=>{
 const draft=cell('draft','state',''),right:MountedCell[]=[draft],runner=setup([cell('draft','state','saved')],right,pass=>{
  if(pass===1)draft.reset('reset')
  else right[0]={...cell('draft','state','saved'),schema:{root:0,nodes:[{kind:'primitive',name:'number'}]}}
 })
 const result=runner.receive(runner.send().packet)
 expect(result.receipt.outcome).toBe('rejected');expect(result.application?.issues).toContainEqual({id:'draft',reason:'incoming-type'})
})

test('incomplete observation uses temporary full repair and catches unobserved effect writes',()=>{
 const old={n:0},feed=cell('feed','ref',[old]),selected=cell('selected','state',null),runner=setup([cell('feed','ref',[{n:1}])],[feed,selected],pass=>{if(pass===1)old.n=7})
 runner.loseObservation()
 const result=runner.receive(runner.send().packet)
 expect(result.receipt.outcome).toBe('accepted');expect(old.n).toBe(1);expect(result.application).toHaveProperty('repairMode','snapshot');expect(result.application?.changed).toEqual([]);expect(result.application).toHaveProperty('journalObjects',0)
})
test('a loss of observation requests a full retry which can then repair unobserved effects',()=>{
 const old={n:0},feed=cell('feed','ref',[old]),runner=setup([cell('feed','ref',[{n:1}])],[feed],pass=>{if(pass===1){runner.loseObservation();old.n=7}else if(pass===2)old.n=8})
 const first=runner.receive(runner.send().packet)
 expect(first.receipt.outcome).toBe('rejected');expect(first.retry).toBe('full')
 const pending=runner.send();expect(pending.sent.kind).toBe('initial');const result=runner.receive(pending.packet)
 expect(result.receipt.outcome).toBe('accepted');expect(old.n).toBe(1);expect(result.application).toHaveProperty('repairMode','snapshot');expect(result.application?.changed).toEqual([])
})

test('state can replace unsupported current values while a live ref rejects before any writes',()=>{
 for(const kind of['state','ref'] as const){
  const source=cell('value',kind,1);source.schema={root:0,nodes:[{kind:'primitive',name:'number'}]}
  let current:unknown=()=>0,writes=0
  const target:MountedCell={id:'value',kind,schema:source.schema,read:()=>current,stale:()=>false,write(value){current=value;writes++}}
  const runner=setup([source],[target]),first=runner.receive(runner.send().packet)
  if(kind==='ref'){expect(first.receipt.outcome).toBe('rejected');expect(writes).toBe(0);continue}
  expect(first.receipt.outcome).toBe('accepted');expect(current).toBe(1)
  current=new AbortController();source.reset(2)
  const pending=runner.send();expect(pending.sent.kind).toBe('delta')
  const second=runner.receive(pending.packet);expect(second.receipt.outcome).toBe('accepted');expect(current).toBe(2);expect(writes).toBe(2)
 }
})
test('a state collection with executable own methods requests a fresh replacement without invoking them',()=>{
 const source=cell('value','state',new Map([['x',{n:1}]])),target=cell('value','state',new Map()),runner=setup([source],[target])
 runner.receive(runner.send().packet)
 let calls=0;const old=target.read() as Map<string,{n:number}>
 Object.defineProperty(runner.b.touch(old),'get',{value:()=>{calls++;throw Error('Must not execute')},writable:true,enumerable:true,configurable:true})
 runner.a.touch(source.read() as Map<string,{n:number}>).set('x',{n:2})
 const first=runner.receive(runner.send().packet);expect(first.retry).toBe('full');expect(calls).toBe(0)
 const second=runner.receive(runner.send().packet);expect(second.receipt.outcome).toBe('accepted');expect(calls).toBe(0)
 const current=target.read() as Map<string,{n:number}>;expect(current).not.toBe(old);expect(current.get('x')!.n).toBe(2);expect(Reflect.ownKeys(current)).toEqual([])
})
