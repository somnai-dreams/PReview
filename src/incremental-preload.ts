import { observeGeneratedFunctions } from './generated-functions'
import { incrementalCache } from './incremental'
import { observeNativeWrites } from './native-writes'

declare const __PREVIEW_COMPLETE__: boolean
const cache = incrementalCache()
cache.coverage(__PREVIEW_COMPLETE__)
const target = globalThis as typeof globalThis & { __previewIncremental: typeof cache; __previewWrites: { touch: typeof cache.touch; unobserved: () => void } }
target.__previewIncremental = cache
target.__previewWrites = { touch: cache.touch, unobserved: () => cache.coverage(false) }
const generated = observeGeneratedFunctions(() => cache.coverage(false))
observeNativeWrites(cache.touch)
const preloadMs = performance.measure('preview-preload', 'preview-preload-start').duration

addEventListener('DOMContentLoaded', () => {
  const panel = document.createElement('details'), title = document.createElement('summary'), output = document.createElement('pre')
  panel.id = 'incremental-probe'; title.textContent = 'Incremental diagnostics'
  panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#fff;color:#111;padding:8px;border:1px solid #888;font:12px monospace;max-height:40vh;overflow:auto'
  panel.append(title, output); document.body.append(panel)
  const update = () => { output.textContent = JSON.stringify({ ...cache.stats(), generated: generated.stats(), preloadMs, heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null }, null, 2) }
  panel.addEventListener('toggle', update)
  setInterval(() => { if (panel.open) update() }, 1000)
})
