import { expect, test } from 'bun:test'
import { liveProofs } from './live-proofs'
import { data } from './validate'
import type { Schema } from '../values'
const rowsSchema:Schema={root:0,nodes:[{kind:'array',item:1},{kind:'object',fields:[{name:'n',optional:false,shape:2},{name:'meta',optional:false,shape:3}],index:null},{kind:'primitive',name:'number'},{kind:'object',fields:[{name:'label',optional:false,shape:4}],index:null},{kind:'primitive',name:'string'}]}

test('declared validation also proves generic data for a newly allocated wrapper',()=>{
 const graph=liveProofs(0),rows=Array.from({length:10000},(_,n)=>({n,meta:{label:'saved'}}))
 expect(graph.accepts(rowsSchema,rows)).toBe(true);const before=graph.stats().reads
 expect(graph.accepts(data,{rows})).toBe(true);expect(graph.stats().reads-before).toBe(1)
})
test('raw-alias edits invalidate all containing roots without rechecking unrelated subtrees',()=>{
 const graph=liveProofs(0),shared={n:1},left={shared,stable:{value:0}},right=[shared]
 expect(graph.accepts(data,left)).toBe(true);expect(graph.accepts(data,right)).toBe(true)
 graph.touch(shared).n=2;const before=graph.stats().reads
 expect(graph.accepts(data,left)).toBe(true);expect(graph.stats().reads-before).toBe(2)
 const after=graph.stats().reads;expect(graph.accepts(data,right)).toBe(true);expect(graph.stats().reads-after).toBe(1)
})
test('invalid leaf edits cannot reuse a previously successful ancestor type proof',()=>{
 const graph=liveProofs(0),rows=[{n:1,meta:{label:'saved'}}]
 expect(graph.accepts(rowsSchema,rows)).toBe(true)
 Object.defineProperty(graph.touch(rows[0]!.meta),'label',{value:123,writable:true,enumerable:true,configurable:true})
 expect(graph.accepts(rowsSchema,rows)).toBe(false)
 graph.touch(rows[0]!.meta).label='fixed';expect(graph.accepts(rowsSchema,rows)).toBe(true)
})
test('cyclic edits invalidate the containing cached subtree and reject',()=>{
 const graph=liveProofs(0),child:{value:unknown}={value:null},parent={child}
 expect(graph.accepts(data,parent)).toBe(true);graph.touch(child).value=parent
 expect(graph.accepts(data,parent)).toBe(false)
 graph.touch(child).value=null;expect(graph.accepts(data,parent)).toBe(true)
})
test('proposed invalid edits reject before writes and cannot publish successful prefix proofs',()=>{
 const graph=liveProofs(0),row={n:1,meta:{label:'saved'}},rows=[row]
 expect(graph.accepts(rowsSchema,rows)).toBe(true)
 const proposed=new Map<object,object>([[row.meta,{label:123}]]),phase=graph.begin(proposed)
 expect(phase.accepts(rowsSchema,rows)).toBe(false);phase.abort()
 expect(row.meta.label).toBe('saved');expect(graph.accepts(rowsSchema,rows)).toBe(true)
 graph.touch(row.meta).label='changed';expect(graph.accepts(rowsSchema,rows)).toBe(true)
})
test('successful proposed edits keep aliases and refresh proof dependencies after the write',()=>{
 const graph=liveProofs(0),old={n:1},replacement={n:2},root={child:old}
 expect(graph.accepts(data,root)).toBe(true)
 const phase=graph.begin(new Map([[root,{child:replacement}]]))
 expect(phase.accepts(data,root)).toBe(true);phase.commit(()=>{root.child=replacement})
 const before=graph.stats().reads;expect(graph.accepts(data,root)).toBe(true);expect(graph.stats().reads).toBe(before)
 graph.touch(replacement).n=3;expect(graph.accepts(data,root)).toBe(true);expect(graph.stats().reads-before).toBe(2)
 const next=graph.stats().reads;graph.touch(old).n=9;expect(graph.accepts(data,root)).toBe(true);expect(graph.stats().reads).toBe(next)
})
test('writes after validation invalidate prospective proofs even when commit succeeds',()=>{
 const graph=liveProofs(0),root={n:1};expect(graph.accepts(data,root)).toBe(true)
 const phase=graph.begin(new Map([[root,{n:2}]]));expect(phase.accepts(data,root)).toBe(true)
 phase.commit(()=>{root.n=2;Object.defineProperty(graph.touch(root),'n',{get(){throw Error('Must not execute')},configurable:true,enumerable:true})})
 expect(graph.accepts(data,root)).toBe(false)
})
test('a rejected alternative cannot become valid when a later independent phase commits',()=>{
 const graph=liveProofs(0),root={n:1},number:Schema={root:0,nodes:[{kind:'object',fields:[{name:'n',optional:false,shape:1}],index:null},{kind:'primitive',name:'number'}]},string:Schema={root:0,nodes:[{kind:'object',fields:[{name:'n',optional:false,shape:1}],index:null},{kind:'primitive',name:'string'}]}
 expect(graph.accepts(number,root)).toBe(true)
 const phase=graph.begin(new Map([[root,{n:'fake'}]]));expect(phase.accepts(string,root)).toBe(true);phase.abort()
 expect(graph.accepts(data,{unrelated:true})).toBe(true);expect(graph.accepts(string,root)).toBe(false)
})
test('root ownership releases obsolete parents while a shared child stays alive',async()=>{
 const graph=liveProofs(0),shared={n:1},weak:WeakRef<object>[]=[]
 function install(){for(let n=0;n<1000;n++){const value={n,shared};weak.push(new WeakRef(value));expect(graph.accepts(data,value)).toBe(true)}}
 install();expect(graph.stats().objects).toBe(1001)
 graph.keep([shared]);expect(graph.stats().objects).toBe(1)
 for(let n=0;n<10;n++){await Bun.sleep(0);Bun.gc(true);await Bun.sleep(0);if(graph.stats().objects===1)break}
 // Metadata release is deterministic. Collection of the actual data still
 // follows the VM; no entry may keep an otherwise unreachable parent alive.
 const alive=weak.filter(ref=>ref.deref()!==undefined).length
 expect(alive).toBeLessThan(10);expect(graph.stats().objects).toBe(1)
 graph.touch(shared).n=2;expect(graph.accepts(data,shared)).toBe(true)
 graph.clear();expect(graph.stats().objects).toBe(0)
})
test('union members and wire aliases retain the canonical destination identity',()=>{
 const graph=liveProofs(0),child={n:1},root={child},wireChild={n:2},wireRoot={child:wireChild}
 const schema:Schema={root:0,nodes:[{kind:'union',members:[1,2]},{kind:'primitive',name:'null'},{kind:'object',fields:[{name:'child',optional:false,shape:3}],index:null},{kind:'object',fields:[{name:'n',optional:false,shape:4}],index:null},{kind:'primitive',name:'number'}]}
 expect(graph.accepts(schema,root)).toBe(true);const count=graph.stats().objects
 const phase=graph.begin(new Map<object,object>([[root,wireRoot],[child,wireChild]]),false,new Map<object,object>([[wireRoot,root],[wireChild,child]]))
 expect(phase.accepts(schema,wireRoot)).toBe(true);expect(graph.stats().objects).toBe(count)
 phase.commit(()=>{child.n=2});expect(root.child).toBe(child)
 const before=graph.stats().reads;expect(graph.accepts(schema,root)).toBe(true);expect(graph.stats().reads).toBe(before)
 graph.touch(child).n=3;expect(graph.accepts(schema,root)).toBe(true);expect(graph.stats().reads-before).toBe(2)
})

test('failed first construction releases successful prefixes and their dependency edges',()=>{
 const graph=liveProofs(0),child={n:1},value={child,bad:()=>0}
 expect(graph.accepts(data,value)).toBe(false)
 expect(graph.stats().objects).toBe(0)
 expect(graph.accepts(data,child)).toBe(true);graph.keep([child])
 graph.touch(child).n=2;expect(graph.accepts(data,child)).toBe(true)
 graph.clear();expect(graph.stats().objects).toBe(0)
})
test('failed union alternatives do not duplicate or retain first-construction edges',()=>{
 const graph=liveProofs(0),a={n:1},b={n:2},value={a,b,tag:'second'}
 const schema:Schema={root:0,nodes:[{kind:'union',members:[1,2]},{kind:'object',fields:[{name:'a',optional:false,shape:3},{name:'tag',optional:false,shape:4}],index:null},{kind:'object',fields:[{name:'b',optional:false,shape:3},{name:'tag',optional:false,shape:5}],index:null},{kind:'data'},{kind:'literal',value:'first'},{kind:'literal',value:'second'}]}
 expect(graph.accepts(schema,value)).toBe(true);graph.keep([value]);expect(graph.stats().objects).toBe(3)
 graph.touch(a).n=3;expect(graph.accepts(schema,value)).toBe(true)
 graph.keep([b]);expect(graph.stats().objects).toBe(1);graph.clear();expect(graph.stats().objects).toBe(0)
})
