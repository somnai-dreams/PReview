import {expect,test} from 'bun:test'
import {liveProofs} from './live-proofs'
import {data} from './validate'
import {nativeWriter} from './raw-transfer'
import {snapshotRepair} from './snapshot-repair'

test('full snapshot repair catches unobserved writes and restores ordered shared data',()=>{
 const graph=liveProofs(0),one={n:1},two={n:2},root={rows:[one,two],map:new Map([['one',one],['two',two]]),selected:one}
 graph.accepts(data,root)
 const roots=[{schema:data,value:root,kind:'ref' as const}],repair=snapshotRepair(graph,roots,nativeWriter())
 try{
  root.rows.reverse();one.n=9;root.map.delete('one');root.map.set('one',two);root.selected=two
  expect(repair.changed()).toEqual([root]);expect(repair.repair().ok).toBe(true)
  expect(root.rows).toEqual([{n:1},{n:2}]);expect([...root.map.keys()]).toEqual(['one','two']);expect(root.map.get('one')).toBe(root.selected);expect(root.selected).toBe(root.rows[0]!);expect(repair.changed()).toEqual([])
  two.n=7;expect(repair.changed()).toEqual([root])
 }finally{repair.close()}
})
test('readonly fallback replacement preserves its immutable comparison source',()=>{
 const graph=liveProofs(0),old={n:1},root={rows:[old],selected:old};graph.accepts(data,root)
 const roots=[{schema:data,value:root,kind:'ref' as const}],repair=snapshotRepair(graph,roots,nativeWriter())
 try{
  old.n=2;Object.freeze(old);Object.freeze(root.rows);Object.freeze(root)
  expect(repair.repair().ok).toBe(true)
  const restored=roots[0]!.value;expect(restored).not.toBe(root);expect(restored.rows[0]).toBe(restored.selected);expect(restored.selected.n).toBe(1);expect(old.n).toBe(2);expect(repair.changed()).toEqual([])
  restored.selected.n=3;expect(repair.changed()).toEqual([restored]);expect(repair.repair().ok).toBe(true);expect(restored.selected.n).toBe(1)
  expect(graph.stats().objects).toBe(3)
 }finally{repair.close();graph.clear()}
 expect(graph.stats().objects).toBe(0)
})
