import type { Schema } from '../values'
import { container, data, validate, type Proofs } from './validate'

type Phase = { status: 'pending' | 'accepted' | 'rejected' }
type Children = Entry | Entry[] | undefined
type Parents = Entry | Set<Entry> | undefined
export type Entry = {
  id: number
  value: object
  roots: number
  revision: number
  validatedRevision: number
  needsEdges: boolean
  parents: Parents
  children: Children
  phase: Phase
  dataHeight: number
  schema: Schema | undefined
  shape: number
  typeHeight: number
  shared: boolean
}
// Identities are sequential within a replica. Index their low bits directly;
// hash only occupied blocks, including sparse identities imported from peers.
// Empty blocks disappear with their last entry, so old namespaces do not keep
// an ever-growing array alive after roots are released.
function entryTable(){
  const width=256,pages=new Map<number,{slots:(Entry|undefined)[];used:number}>()
  let size=0
  const get=(id:number)=>pages.get(Math.floor(id/width))?.slots[id%width]
  return {
    get,has:(id:number)=>get(id)!==undefined,
    get size(){return size},
    set(id:number,entry:Entry){
      const key=Math.floor(id/width),offset=id%width
      let page=pages.get(key)
      if(page===undefined){page={slots:Array.from({length:width},()=>undefined),used:0};pages.set(key,page)}
      if(page.slots[offset]===undefined){page.used++;size++}
      page.slots[offset]=entry
    },
    delete(id:number){
      const key=Math.floor(id/width),page=pages.get(key),offset=id%width
      if(page===undefined||page.slots[offset]===undefined)return
      page.slots[offset]=undefined;page.used--;size--
      if(page.used===0)pages.delete(key)
    },
    *values(){for(const page of pages.values())for(const entry of page.slots)if(entry!==undefined)yield entry},
  }
}
const count = (children: Children) => children === undefined ? 0 : Array.isArray(children) ? children.length : 1
const at = (children: Children, index: number): Entry => Array.isArray(children) ? children[index]! : children!
function addParent(child: Entry, parent: Entry) {
  const old = child.parents
  if (old === undefined) child.parents = parent
  else if (old instanceof Set) old.add(parent)
  else if (old !== parent) child.parents = new Set([old, parent])
}
function removeParent(child: Entry, parent: Entry) {
  const old = child.parents
  if (old === parent) child.parents = undefined
  else if (old instanceof Set) {
    old.delete(parent)
    if (old.size === 0) child.parents = undefined
    else if (old.size === 1) child.parents = old.values().next().value
  }
}

// The comparison owns its registered roots. Entries share the actual graph;
// they do not own another snapshot or an independent garbage-collection graph.
// Detached entries are released when their last root/parent ownership ends.
export function liveProofs(site: number) {
  const span=4294967296
  if(!Number.isSafeInteger(site)||site<0||site>=2097152)throw Error('Invalid replica namespace')
  const objects = new WeakMap<object, Entry | number>(), ids = entryTable(), dirty = new Set<Entry>()
  function lookup(value:object){const entry=objects.get(value);return typeof entry==='object'?entry:undefined}
  let next: number = site*span, reads = 0, hits = 0, epoch=0, unshared=0
  let current: Phase | undefined
  let incomingIdentity: ((value:object)=>number|undefined) | undefined
  let roots: Entry[] = []
  let beforeWrite: ((entry:Entry)=>void) | undefined
  const staged = new Set<Entry>()
  const empty: Phase = {status:'rejected'}
  function shareEntry(entry:Entry){if(!entry.shared&&ids.get(entry.id)===entry){entry.shared=true;unshared--}}
  function acceptsIdentity(id:number){return Number.isSafeInteger(id)&&id>=0&&(Math.floor(id/span)!==site||id<next)}
  function release(entry: Entry) {
    if (entry.roots!==0 || entry.parents!==undefined || ids.get(entry.id) !== entry) return
    ids.delete(entry.id);dirty.delete(entry)
    if(!entry.shared)unshared--
    objects.delete(entry.value)
    for(let i=0;i<count(entry.children);i++){const child=at(entry.children,i);removeParent(child,entry);release(child)}
  }
  function get(value: object, proposedId?:number) {
    const prior=lookup(value)
    if(prior!==undefined&&ids.get(prior.id)===prior)return prior
    const incoming=proposedId??incomingIdentity?.(value),id=incoming??next
    if(incoming===undefined&&next>=(site+1)*span)throw Error('Object identities exhausted')
    if(incoming!==undefined&&!acceptsIdentity(incoming))throw Error('Invalid imported identity')
    if(ids.has(id))throw Error('Conflicting object identity')
    const entry:Entry={id,value,roots:0,revision:0,validatedRevision:-1,needsEdges:true,parents:undefined,children:undefined,phase:empty,dataHeight:0,schema:undefined,shape:0,typeHeight:0,shared:false}
    if(incoming===undefined)next++
    objects.set(value,entry);ids.set(entry.id,entry);staged.add(entry);unshared++
    return entry
  }
  function invalidate(entry:Entry) {
    const already=entry.validatedRevision!==entry.revision;entry.revision++
    if(already)return
    const parents=entry.parents
    if(parents instanceof Set)for(const parent of parents.values())invalidate(parent)
    else if(parents!==undefined)invalidate(parents)
  }
  function touch<T>(value:T):T {
    if(container(value)){
      const entry=lookup(value)
      if(entry!==undefined&&ids.get(entry.id)===entry){beforeWrite?.(entry);epoch++;entry.needsEdges=true;dirty.add(entry);invalidate(entry)}
    }
    return value
  }
  function assignment<T>(value: object, key: string, next: T): T {
    // The original JS assignment still executes. Only an unchanged own data
    // property avoids invalidation; additions, accessors and changed values
    // retain the ordinary before-write path and its repair journal.
    const entry = lookup(value)
    if (entry !== undefined && ids.get(entry.id) === entry) {
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (field === undefined || !('value' in field) || !Object.is(field.value, next)) touch(value)
    }
    return next
  }
  function detachChildren(entry:Entry){
    const old=entry.children;entry.children=undefined
    for(let i=0;i<count(old);i++){const child=at(old,i);removeParent(child,entry);staged.add(child)}
  }
  function attach(parent:Entry,child:Entry){
    const children=parent.children
    if(children===undefined)parent.children=child
    else if(Array.isArray(children))children.push(child)
    else parent.children=[children,child]
    addParent(child,parent);staged.delete(child)
  }
  function relink(entry:Entry,value:object){
    detachChildren(entry)
    function child(value:unknown){
      if(!container(value))return
      attach(entry,get(value))
    }
    if(value instanceof Map){for(const [key,item] of value){child(key);child(item)}}
    else if(value instanceof Set){for(const item of value)child(item)}
    else for(const key of Object.keys(value))child(Object.getOwnPropertyDescriptor(value,key)!.value)
    entry.needsEdges=false
  }
  function keep(values:readonly unknown[]){
    const next:Entry[]=[]
    for(const value of values)if(container(value)){const entry=lookup(value);if(entry!==undefined&&ids.get(entry.id)===entry){entry.roots++;next.push(entry)}}
    for(const root of roots){root.roots--;staged.add(root)}
    roots=next
    for(const entry of staged)release(entry)
    staged.clear()
  }
  function begin(overrides: ReadonlyMap<object,object> = new Map(), full=false, identities: Pick<ReadonlyMap<object,object>,'get'> = new Map(), identify?: (value:object)=>number|undefined,pair?:(value:object,candidate:unknown)=>object){
    if(current!==undefined)throw Error('Another validation phase is open')
    const phase:Phase={status:'pending'},built:Entry[]=[];current=phase;incomingIdentity=identify
    for(const value of overrides.keys()){const entry=get(value);entry.needsEdges=true;invalidate(entry)}
    function usable(entry:Entry){
      return entry.validatedRevision===entry.revision&&(entry.phase===phase||!full&&entry.phase.status==='accepted')
    }
    const proofs:Proofs={
      ...(pair===undefined?{}:{pair}),
      identity:value=>identities.get(value)??value,
      read(value){
        reads++
        const entry=lookup(value)??get(value)
        if(full)entry.needsEdges=true
        if(entry.validatedRevision===-1)detachChildren(entry)
        return overrides.get(value)??value
      },
      child(parent,value){
        const owner=lookup(parent)
        if(owner!==undefined&&owner.validatedRevision===-1){
          const child=lookup(identities.get(value)??value)
          if(child===undefined)throw Error('Missing validated dependency')
          attach(owner,child)
        }
      },
      known(schema,value,id){
        const entry=lookup(value);if(entry===undefined||ids.get(entry.id)!==entry||!usable(entry))return undefined
        if(schema.nodes[id]?.kind==='data'){hits++;return entry.dataHeight}
        if(entry.schema===schema&&entry.shape===id){hits++;return entry.typeHeight}
        return undefined
      },
      remember(schema,value,id,height){
        const entry=lookup(value)??get(value)
        // New entries acquire edges during the mandatory validation traversal.
        // Existing entries keep their old edges until writes commit, so a
        // rejected prospective update cannot corrupt live ownership.
        if(entry.validatedRevision===-1)entry.needsEdges=false
        if(entry.phase!==phase)built.push(entry)
        // Keep proof facts in the existing node. A second proof object for
        // every successful visit added substantial allocation in the first run.
        if(!usable(entry)){entry.schema=undefined;entry.typeHeight=0;entry.dataHeight=height}
        else entry.dataHeight=Math.min(entry.dataHeight,height)
        if(schema.nodes[id]?.kind!=='data'){entry.schema=schema;entry.shape=id;entry.typeHeight=height}
        entry.validatedRevision=entry.revision;entry.phase=phase
      }
    }
    return {
      accepts(schema:Schema,value:unknown,candidate?:unknown){if(phase.status!=='pending')throw Error('Validation phase closed');return validate(schema,value,proofs,schema.root,candidate)},
      entries:()=>built,
      commit(write?:()=>void){
        if(phase.status!=='pending')throw Error('Validation phase closed')
        try{
          write?.()
          for(const entry of built){
            if(usable(entry)&&entry.needsEdges)relink(entry,entry.value)
          }
          phase.status='accepted'
        }catch(error){phase.status='rejected';throw error}finally{current=undefined;incomingIdentity=undefined}
      },
      abort(){if(phase.status!=='pending')throw Error('Validation phase closed');phase.status='rejected';current=undefined;incomingIdentity=undefined},
      close(){if(phase.status==='pending'){phase.status='rejected';current=undefined;incomingIdentity=undefined}if(phase.status==='rejected'){for(const entry of staged)release(entry);staged.clear()}},
    }
  }
  function adopt(value:object,id:number,replace=false){
    if(!acceptsIdentity(id))throw Error('Invalid object identity')
    const entry=get(value),occupied=ids.get(id)
    if(occupied!==undefined&&occupied!==entry){
      if(!replace)throw Error('Conflicting object identity')
      // The displaced readonly value remains an ordinary local object. Move
      // its existing entry into the replacement's unused local identity; this
      // preserves ownership until keep() releases its old roots and parents.
      // Replacing ids[id] alone would orphan those dependency edges.
      if(occupied.shared)unshared++
      occupied.id=entry.id;occupied.shared=false;ids.set(occupied.id,occupied)
      entry.id=id;ids.set(id,entry)
    }else if(entry.id!==id){ids.delete(entry.id);entry.id=id;ids.set(id,entry)}
    return entry
  }
  function beginNative(sources:object[],identities:Float64Array,choose:(source:object,candidate:unknown,id:number)=>object){
    // A full native clone has no references into an older destination graph.
    // Planning is injective, so validating its original values also validates
    // the eventual destination values. Temporarily bind both identities to the
    // same entry instead of translating every read through two more maps.
    // The graph's object table owns incoming identities too. Adopted native
    // objects keep their slot; temporary aliases to existing targets are
    // removed when this phase closes. No parallel source-object map survives.
    if(current!==undefined)throw Error('Another validation phase is open')
    let registered=0
    try{
      for(const source of sources){if(objects.has(source))throw Error('Duplicate or live native object');objects.set(source,identities[registered]!);registered++}
    }catch(error){for(let i=0;i<registered;i++)objects.delete(sources[i]!);throw error}
    let paired=0
    const phase=begin(new Map(),false,new Map(),undefined,(source,candidate)=>{
      const id=objects.get(source)
      if(id===undefined)throw Error('Missing identity')
      if(typeof id==='object')return id.value
      const target=choose(source,candidate,id),entry=get(target,ids.has(id)?undefined:id)
      entry.needsEdges=true;invalidate(entry);objects.set(source,entry);paired++
      return target
    })
    return {...phase,pairs:{get:lookup,size:()=>paired},close(){
      try{phase.close()}finally{for(const source of sources){const entry=objects.get(source);if(typeof entry==='number'||entry!==undefined&&entry.value!==source)objects.delete(source)}}
    }}
  }
  return {get,adopt,find:(id:number)=>ids.get(id)?.value,identity:(value:object)=>lookup(value)?.id,acceptsIdentity,touch,assignment,begin,beginNative,dirty,keep,
    entries:()=>ids.values(),
    version:(value:unknown)=>container(value)?lookup(value)?.revision:undefined,
    ancestors(values:readonly object[]){
      const result=new Set<object>()
      function visit(entry:Entry){
        if(result.has(entry.value))return
        result.add(entry.value)
        if(entry.parents instanceof Set)for(const parent of entry.parents)visit(parent)
        else if(entry.parents!==undefined)visit(entry.parents)
      }
      for(const value of values){const entry=lookup(value);if(entry!==undefined&&ids.get(entry.id)===entry)visit(entry)}
      return result
    },
    observeWrites(record:(entry:Entry)=>void){
      if(beforeWrite!==undefined)throw Error('A write journal is already open')
      beforeWrite=record
      return ()=>{if(beforeWrite!==record)throw Error('Write journal already closed');beforeWrite=undefined}
    },
    revision:()=>epoch,
    shareEntry,
    share(){for(const entry of ids.values())shareEntry(entry)},
    stats:()=>({objects:ids.size,dirty:dirty.size,unshared,reads,hits}),
    clear(){keep([])},
    accepts(schema:Schema,value:unknown){const phase=begin();try{const valid=phase.accepts(schema,value);if(valid){phase.commit();keep([...roots.map(entry=>entry.value),value])}else phase.abort();return valid}finally{phase.close()}},
    data,
  }
}
