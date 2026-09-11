import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

const source=(await Bun.file(new URL('./react-cache.js',import.meta.url)).text()).replace(/^import .*$/gm,'').replace(/^export \* .*$/gm,'').replaceAll('export function ','function ').replace(/^export default .*$/gm,'')
type Props=Record<string,unknown>
type Component=((props:Props)=>unknown)&{defaultProps?:Props}
type Wrapped={type:(props:Props,ref:unknown)=>unknown;compare:(previous:Props,next:Props)=>boolean;defaultProps?:Props}
function fixture(){
 let revision=0
 const versions=new Map<unknown,number>()
 const effects:(()=>void)[]=[],calls:{kind:string;deps:unknown}[]=[]
 const api=runInNewContext(source+'\n;({useMemo,useCallback,memo})',{
  renderRevision:()=>revision,
  valueVersion:(value:unknown)=>versions.get(value),
  React:{
   useMemo(create:()=>unknown,deps:unknown){calls.push({kind:'memo',deps});return create()},
   useCallback(callback:unknown,deps:unknown){calls.push({kind:'callback',deps});return callback},
   useLayoutEffect(effect:()=>void){effects.push(effect)},
   forwardRef:(render:unknown)=>render,
   memo:(type:unknown,compare:unknown)=>({type,compare}),
   createElement:(component:unknown,props:Props)=>({component,props}),
  },
 }) as {useMemo(create:()=>unknown,deps?:readonly unknown[]|null):unknown;useCallback(callback:unknown,deps?:readonly unknown[]|null):unknown;memo(component:Component,compare?:((previous:Props,next:Props)=>boolean)|null):Wrapped}
 return{api,calls,versions,advance(){revision++},commit(){for(const effect of effects.splice(0))effect()},abandon(){effects.length=0}}
}
test('memo dependencies change only across restore commits and never modify caller arrays',()=>{
 const f=fixture(),deps=[{}],callback=()=>0
 f.api.useMemo(()=>1,deps);f.api.useCallback(callback,deps);f.api.useMemo(()=>1,deps)
 expect(f.calls[0]!.deps).toEqual([0,...deps,undefined]);expect(f.calls[1]!.deps).toEqual(f.calls[0]!.deps);expect(f.calls[2]!.deps).toEqual(f.calls[0]!.deps);expect(deps).toHaveLength(1)
 f.advance();f.api.useMemo(()=>1,deps);expect(f.calls.at(-1)!.deps).toEqual([1,...deps,undefined])
 f.api.useMemo(()=>1);expect(f.calls.at(-1)!.deps).toBeUndefined();f.api.useCallback(callback,null);expect(f.calls.at(-1)!.deps).toBeNull()
})
test('tracked in-place edits invalidate memo dependencies and props during ordinary renders',()=>{
 const f=fixture(),row={},props={row},wrapped=f.api.memo(()=>null)
 f.versions.set(row,0);wrapped.type(props,null);f.commit();f.api.useMemo(()=>0,[row])
 expect(wrapped.compare(props,{row})).toBe(true)
 f.versions.set(row,1);expect(wrapped.compare(props,{row})).toBe(false);f.api.useMemo(()=>1,[row])
 expect(f.calls[0]!.deps).toEqual([0,row,0]);expect(f.calls[1]!.deps).toEqual([0,row,1])
})
test('React.memo uses committed render revisions, never a speculative comparator result',()=>{
 const f=fixture(),wrapped=f.api.memo(()=>null),before={row:{}},after={...before}
 wrapped.type(before,null);f.commit();expect(wrapped.compare(before,after)).toBe(true)
 f.advance();expect(wrapped.compare(before,after)).toBe(false)
 wrapped.type(after,null);f.abandon();expect(wrapped.compare(before,after)).toBe(false)
 wrapped.type(after,null);f.commit();expect(wrapped.compare(after,{...after})).toBe(true)
 expect(wrapped.compare(after,{row:{}})).toBe(false)
})
test('memo retains custom comparison, default props and forwarded refs',()=>{
 const f=fixture(),component:Component=()=>null;component.defaultProps={color:'blue'}
 const wrapped=f.api.memo(component,()=>true),props={color:'blue'},ref={current:null}
 expect(wrapped.defaultProps).toBe(component.defaultProps)
 const rendered=wrapped.type(props,ref) as {component:Component;props:Props};f.commit()
 expect(rendered.component).toBe(component);expect(rendered.props['ref']).toBe(ref)
 expect(wrapped.compare(props,{color:'red'})).toBe(true);f.advance();expect(wrapped.compare(props,{color:'red'})).toBe(false)
 const normal=f.api.memo(component,null);normal.type(props,null);f.commit();expect(normal.compare(props,{color:'red'})).toBe(false)
})
