import { expect, test } from 'bun:test'
import { cell, data, harness, transfer, journal } from './runtime-harness.test'
import type { Value } from './values'

test('state transfer uses the installed navigation owner instead of a second journal', async () => {
  const saved = { entries: [{ path: '/detail', state: { returnTo: '/list' } }], index: 0 }
  let restored: unknown = null
  const a = harness({ navigation: { history: () => saved, restore() { throw Error('Source must not restore') } } })
  const b = harness({ navigation: { history: () => journal, restore(value) { restored = value } } })
  a.runtime.register(cell('draft', 'state', 'saved'))
  b.runtime.register(cell('draft', 'state', 'original'))
  expect((await transfer(a, b)).report.rejected).toEqual([])
  expect(restored).toEqual(saved)
  expect(b.histories).toEqual([])
})

test('actual runtime restores named cells, repairs mounts, and sends aliases directly between frames', async () => {
  const row = { title: 'saved' }, source = harness(), feed = cell('feed','ref',[]), draft = cell('draft','state',''), selected = cell('selected','state',null), child = cell('child','state','')
  const target = harness({ afterCommit(pass) { if (pass === 1) { draft.reset('effect'); selected.reset({title:'saved'}); target.runtime.register(child) } } })
  for (const c of [cell('feed','ref',[row]),cell('draft','state','saved'),cell('selected','state',row),cell('child','state','caption')]) source.runtime.register(c)
  for (const c of [feed,draft,selected]) target.runtime.register(c)
  const result = await transfer(source,target)
  expect(result.target.error).toBeUndefined(); expect(result.report.rejected).toEqual([])
  expect(draft.read()).toBe('saved'); expect(child.read()).toBe('caption'); expect(selected.read()).toBe((feed.read() as Value[])[0])
  expect(result.report.secondPass).toEqual(['draft','selected','child']); expect(feed.writes()).toBe(1); expect(target.runtime.pending()).toBeNull()
  expect(JSON.stringify(source.replies)).not.toContain('caption'); expect(JSON.stringify(target.replies)).not.toContain('caption')
})
test('warm no-change messages do no React work and observed nested edits survive three builds', async () => {
  const a=harness(),b=harness(),c=harness(),row={n:1},left=cell('feed','ref',[row]),middle=cell('feed','ref',[]),right=cell('feed','ref',[])
  a.runtime.register(left);b.runtime.register(middle);c.runtime.register(right)
  expect((await transfer(a,b)).report.rejected).toEqual([])
  const commits=b.commits();expect((await transfer(a,b)).report.changed).toEqual([]);expect(b.commits()).toBe(commits)
  a.bridge.touch(row).n=2
  expect((await transfer(a,b)).report.rejected).toEqual([]);expect(middle.read()).toEqual([{n:2}])
  expect((await transfer(b,c)).report.rejected).toEqual([]);expect(right.read()).toEqual([{n:2}])
  c.bridge.touch((right.read() as {n:number}[])[0]!).n=3
  expect((await transfer(c,a)).report.rejected).toEqual([]);expect(left.read()).toEqual([{n:3}])
})
test('runtime replaces stale unsupported state but rejects an invalid live ref before writes', async () => {
  for (const kind of ['state','ref'] as const) {
    const a=harness(),b=harness(),source=cell('value',kind,1),target=cell('value',kind,new AbortController()),draft=cell('draft','state','local')
    a.runtime.register(source);a.runtime.register(cell('draft','state','incoming'));b.runtime.register(target);b.runtime.register(draft)
    const result=await transfer(a,b)
    expect(result.target.error).toBeUndefined()
    if(kind==='state'){expect(result.report.rejected).toEqual([]);expect(target.read()).toBe(1)}
    else{expect(result.report.rejected).not.toEqual([]);expect(draft.writes()).toBe(0);expect(target.writes()).toBe(0)}
  }
})
test('a frozen destination delta requests a new full capture without using an old live packet', async () => {
  const a=harness(),b=harness(),row={n:1},source=cell('row','ref',row),target=cell('row','ref',{n:0});a.runtime.register(source);b.runtime.register(target)
  await transfer(a,b)
  Object.freeze(b.bridge.touch(target.read()));a.bridge.touch(row).n=2
  expect((await transfer(a,b)).report.retry).toBe(true)
  a.bridge.touch(row).n=3
  expect((await transfer(a,b)).report.rejected).toEqual([]);expect(target.read()).toEqual({n:3})
})
test('observed and unobserved effects preserve aliases and report repeated changes', async () => {
  for (const observed of [true,false]) {
    const a=harness(),row={n:0},target=cell('feed','ref',[row]),selected=cell('selected','state',null)
    const b=harness({observed,afterCommit(){if(observed)b.bridge.touch(row);row.n=7}})
    const saved={n:1};a.runtime.register(cell('feed','ref',[saved]));a.runtime.register(cell('selected','state',saved));b.runtime.register(target);b.runtime.register(selected)
    const result=await transfer(a,b)
    expect(result.target.error).toBeUndefined();expect(result.report.rejected).toEqual([]);expect(result.report.changed).toEqual(['feed','selected']);expect(selected.read()).toBe(row)
    expect(result.report.repairMode).toBe(observed?'observed':'snapshot')
  }
})
test('pending mount initialization retains cross-cell identity and validates destination schema', async () => {
  const a=harness(),bFeed=cell('feed','ref',[]),trigger=cell('trigger','state',false)
  let mounted: {current:Value}|undefined
  const b=harness({afterCommit(pass){if(pass===1)mounted=b.runtime.mountRef('selected',data,null)}})
  const row={n:1};for(const c of[cell('feed','ref',[row]),cell('trigger','state',true),cell('selected','ref',row)])a.runtime.register(c)
  b.runtime.register(bFeed);b.runtime.register(trigger)
  const result=await transfer(a,b)
  expect(result.target.error).toBeUndefined();expect(mounted!.current).toBe((bFeed.read() as Value[])[0]);expect(result.report.rejected).toEqual([])
})
test('context validation rejects invalid history and scroll before graph application', () => {
  const b=harness()
  for (const context of [
    {session:null,history:{entries:[{path:'https://other.example',state:null}],index:0},scroll:[]},
    {session:null,history:journal,scroll:[{id:'feed',top:NaN,left:0,anchor:null}]},
    {session:null,history:journal,scroll:[{id:'feed',top:1,left:0,anchor:{path:'https://other.example',offset:0}}]},
  ]) expect(()=>b.runtime.context(context)).toThrow()
  expect(b.commits()).toBe(0)
})
test('frame identity cannot be silently reused for a different reviewer incarnation',()=>{
  const a=harness();expect(()=>a.bridge.configure('other',0)).toThrow('reload this build')
})
test('runtime applies native routing before repair and restores scroll by a visible anchor',async()=>{
 const sourceRoute={page:'explore'},targetRoute={page:'explore'},route=cell('route','state',targetRoute)
 let restored:[number,number]|null=null
 function document(top:number,linkTop:number,destination=false){
  const link={href:'https://build.example/jobs/one',getBoundingClientRect:()=>({top:linkTop,bottom:linkTop+40,width:100})}
  const element={id:'feed',scrollTop:top,scrollLeft:0,clientHeight:200,scrollHeight:1000,getBoundingClientRect:()=>({top:100,bottom:300}),querySelectorAll:()=>[link],scrollTo(left:number,top:number){restored=[left,top]}}
  return{querySelectorAll:()=>[element],getElementById:()=>destination?element:null}
 }
 const a=harness({historyState:sourceRoute,document:document(120,120)}),b=harness({historyState:targetRoute,document:document(10,170,true),onPopState:state=>route.reset(state)})
 const source=cell('route','state',sourceRoute);a.runtime.register(source);b.runtime.register(route)
 source.reset({page:'detail'});a.runtime.push(source.read(),'','/jobs/one')
 expect(route.read()).toEqual({page:'explore'})
 const result=await transfer(a,b)
 expect(route.read()).toEqual({page:'detail'});expect(result.report.rejected).toEqual([]);expect(b.histories.at(-1)).toEqual({state:{page:'detail'},path:'/jobs/one'});expect(JSON.stringify(restored)).toBe('[0,60]');expect(result.report.scrollRestored).toEqual([{id:'feed',method:'anchor'}])
})
