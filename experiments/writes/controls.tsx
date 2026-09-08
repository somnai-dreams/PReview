import { comparison } from '../../src/values'
import type { Watch } from './tracker'

type Probe = { watch: (value: unknown) => Watch; unwatch: (watch: Watch) => void }
const probe = (globalThis as typeof globalThis & { __previewWrites?: Probe }).__previewWrites

export function WriteControls() {
  if (probe === undefined) return null
  const writes = probe
  function run() {
    const output = document.getElementById('measurements')!
    const row = { title: 'original' }, root = { row, map: new Map<string, number>(), array: [1] }
    const watch = writes.watch(root)
    const sameIdentity = watch.value === root
    row.title = 'old alias'
    const oldAliasDetected = watch.dirty
    writes.unwatch(watch)
    const inserted = { title: 'inserted' }
    root.row = inserted
    const afterInsertion = writes.watch(root)
    inserted.title = 'edit through inserted raw alias'
    const insertedAliasDetected = afterInsertion.dirty
    writes.unwatch(afterInsertion)
    const collections = writes.watch(root)
    const set = Map.prototype.set
    set.call(root.map, 'one', 1)
    const extractedMapDetected = collections.dirty
    writes.unwatch(collections)
    output.textContent = JSON.stringify({ sameIdentity, oldAliasDetected, insertedAliasDetected, extractedMapDetected }, null, 2)
  }
  function measure() {
    const output = document.getElementById('measurements')!
    const source = { rows: Array.from({ length: 20_000 }, (_, id) => ({ id, title: 'Item ' + id, content: 'x'.repeat(2048), tags: [{ name: 'tag', score: id }] })) }
    const current = structuredClone(source)
    const started = performance.now(), watch = writes.watch(current), indexMs = performance.now() - started
    const reading = performance.now()
    const dirtyBefore = watch.dirty, readMs = performance.now() - reading
    const comparing = performance.now()
    for (let pass = 0; pass < 3; pass++) if (!comparison().matches(source, current)) throw new Error('Synthetic comparison failed')
    const threeComparisonsMs = performance.now() - comparing
    current.rows[0]!.title = 'raw alias edit'
    const dirtyAfter = watch.dirty
    const releasing = performance.now()
    writes.unwatch(watch)
    output.textContent = JSON.stringify({ rows: 20_000, payloadCharacters: 40_960_000, indexMs, readMs, threeComparisonsMs, releaseMs: performance.now() - releasing, dirtyBefore, dirtyAfter, note: 'Component timings only. Full comparisons remain enabled.' }, null, 2)
  }
  return <>
    <button onClick={run}>Test compiler write coverage</button>
    <button onClick={measure}>Measure compiler write tracking</button>
  </>
}
