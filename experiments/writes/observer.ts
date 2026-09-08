import { writeTracking, observeNativeWrites, type Watch } from './tracker'

type Cell = { id: string; owner: object; value: unknown }
const tracking = writeTracking()
const watches = new Map<object, Watch>()
let captures = 0, missed = 0, changed = 0, lastMissed: string[] = []
let largest: { id: string; objects: number; dirty: boolean; retained: boolean; sameRoot: boolean }[] = []
let lastCapture = { cells: 0, predicted: 0, retained: 0, comparisonMs: 0, predictionMs: 0, indexingMs: 0 }, lastRestoreIndexMs = 0
observeNativeWrites(tracking.touch)
const observer = {
  touch: tracking.touch,
  watch(value: unknown) { return tracking.baseline(undefined, value) },
  unwatch: tracking.release,
  remove(owner: object) { const watch = watches.get(owner); if (watch !== undefined) { tracking.release(watch); watches.delete(owner) } },
  audit(candidates: Cell[], accepted: Cell[], retained: Set<string>, previousIds: Set<string>, warm: boolean, comparisonMs: number) {
    lastMissed = []
    largest = accepted.map(cell => { const watch = watches.get(cell.owner); return { id: cell.id, objects: watch?.objects.length ?? 0, dirty: watch?.dirty ?? true, retained: retained.has(cell.id), sameRoot: watch !== undefined && Object.is(watch.value, cell.value) } }).sort((a, b) => b.objects - a.objects).slice(0, 8)
    const started = performance.now()
    let predictedCount = 0
    const acceptedIds = new Set(accepted.map(cell => cell.id))
    for (const cell of candidates) {
      // Previously accepted cells must still be audited if a write made them
      // invalid. Never index that new unvalidated graph.
      if (!previousIds.has(cell.id) && !acceptedIds.has(cell.id)) continue
      const watch = watches.get(cell.owner)
      const predicted = !previousIds.has(cell.id) || watch === undefined || watch.dirty || !Object.is(watch.value, cell.value)
      if (predicted) predictedCount++
      if (warm && !retained.has(cell.id)) { changed++; if (!predicted) { missed++; lastMissed.push(cell.id) } }
    }
    lastCapture = { cells: accepted.length, predicted: predictedCount, retained: retained.size, comparisonMs, predictionMs: performance.now() - started, indexingMs: 0 }
    const indexing = performance.now()
    if (warm) captures++
    const present = new Set(accepted.map(cell => cell.owner))
    for (const owner of watches.keys()) if (!present.has(owner)) observer.remove(owner)
    for (const cell of accepted) {
      const previous = watches.get(cell.owner)
      // Reindex even a missed write: full comparison remains authoritative.
      if (previous !== undefined && !retained.has(cell.id)) previous.dirty = true
      watches.set(cell.owner, tracking.baseline(previous, cell.value))
    }
    lastCapture.indexingMs = performance.now() - indexing
  },
  restored(candidates: Cell[], changed: Set<string>) {
    // The receiving checkpoint replaced the comparison baseline. A clean watch
    // of the same live graph still describes its membership. Restore writes are
    // instrumented too; only changed graphs need to rebuild that index.
    const started = performance.now()
    const present = new Set(candidates.filter(cell => !changed.has(cell.id)).map(cell => cell.owner))
    for (const owner of watches.keys()) if (!present.has(owner)) observer.remove(owner)
    for (const cell of candidates) {
      // Verification must establish that the live value still matches the
      // accepted snapshot. A post-commit mismatch may contain resources/getters.
      if (changed.has(cell.id)) continue
      const watch = tracking.baseline(watches.get(cell.owner), cell.value)
      watches.set(cell.owner, watch)
    }
    lastRestoreIndexMs = performance.now() - started
  },
  stats() { return { ...tracking.stats(), captures, changed, missed, lastMissed, lastCapture, lastRestoreIndexMs, largest } },
}
;(globalThis as typeof globalThis & { __previewWrites: typeof observer }).__previewWrites = observer

// Only metadata is rendered; app values remain in their original realm.
addEventListener('DOMContentLoaded', () => {
  const panel = document.createElement('details'), title = document.createElement('summary'), output = document.createElement('pre')
  panel.id = 'write-probe'; title.textContent = 'Write probe'
  panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#fff;color:#111;padding:8px;border:1px solid #888;font:12px monospace;max-height:45vh;overflow:auto'
  panel.append(title, output); document.body.append(panel)
  const update = () => { output.textContent = JSON.stringify(observer.stats(), null, 2) }
  panel.addEventListener('toggle', update)
  setInterval(() => { if (panel.open) update() }, 1000)
})
