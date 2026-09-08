import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { comparison } from '../../../src/values'
import { mutations } from '../mutations'

type Probe = { override: (id: string, value: unknown) => void; stats: () => { commits: number; mappedCells: number } }
const probe = (globalThis as typeof globalThis & { __previewFiberProbe: Probe }).__previewFiberProbe
const raw = { row: { title: 'original' } }
const tracker = mutations()
const wrapped = tracker.wrap(raw)
declare const BUILD_VARIANT: 'A' | 'B'

function App() {
  // A build-time constant: B has an extra hook before the observed state.
  const padding = BUILD_VARIANT === 'B' ? useRef('extra hook in B') : null
  const [draft, setDraft] = useState('start')
  const [earlier, setEarlier] = useState(0)
  const data = useRef<{ title: string; values: number[] }>({ title: 'original', values: [1, 2, 3] })
  const [result, setResult] = useState('Run an experiment')
  const output = document.getElementById('measurements')!
  function measure(action: () => void) {
    const commits = probe.stats().commits, started = performance.now()
    flushSync(action)
    output.textContent = JSON.stringify({ ms: performance.now() - started, commits: probe.stats().commits - commits, mappedCells: probe.stats().mappedCells }, null, 2)
  }
  return <main style={{ maxWidth: 800, margin: '40px auto', font: '16px system-ui', display: 'grid', gap: 14 }}>
    <h1>Fiber and mutation experiment</h1>
    <p>Development-only measurements; ordinary PReview transfer remains authoritative.</p>
    <label>Draft <input value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <output data-padding={padding?.current}>Earlier state: {earlier}; draft: {draft}; ref: {data.current.title}; entries: {data.current.values.length}</output>
    <button onClick={() => measure(() => setDraft('normal setter'))}>Normal setter</button>
    <button onClick={() => measure(() => probe.override('src/App.tsx:App:draft', 'fiber override'))}>Override through fiber</button>
    <button onClick={() => setEarlier(value => value + 1)}>Change earlier hook</button>
    <button onClick={() => { data.current.title = 'ref mutation'; data.current.values.push(4) }}>Mutate ref without render</button>
    <button onClick={() => setResult('Forced render ' + Date.now())}>Render ref result</button>
    <button onClick={() => {
      const before = tracker.revision(); wrapped.row.title = 'wrapped mutation'
      setResult('Wrapped write detected: ' + (tracker.revision() > before))
    }}>Write through proxy</button>
    <button onClick={() => {
      const before = tracker.revision(); raw.row.title = 'raw alias mutation'
      setResult('Raw alias changed: ' + (wrapped.row.title === 'raw alias mutation') + '; observer detected: ' + (tracker.revision() > before))
    }}>Write through old raw alias</button>
    <button onClick={() => {
      const rows = Array.from({ length: 20_000 }, (_, id) => ({ id, title: 'Item ' + id, content: 'x'.repeat(2048), tags: [{ name: 'tag', score: id }] }))
      const source = { rows }, current = structuredClone(source)
      const largeTracker = mutations(), tracked = largeTracker.wrap(current)
      const started = performance.now()
      for (let pass = 0; pass < 3; pass++) { if (!comparison().matches(source, current)) throw new Error('Synthetic equality failed') }
      const scannedMs = performance.now() - started
      const revision = largeTracker.revision(), reading = performance.now()
      const unchanged = revision === largeTracker.revision(), revisionReadMs = performance.now() - reading
      tracked.rows[0]!.title = 'wrapped edit'
      output.textContent = JSON.stringify({ rows: rows.length, payloadCharacters: rows.length * 2048, threeReadPhasesMs: scannedMs, revisionReadMs, unchanged, wrappedWriteDetected: largeTracker.revision() > revision, note: 'Component probe only; revision check misses raw-alias mutations.' }, null, 2)
    }}>Measure large synthetic graph</button>
    <p>{result}</p>
  </main>
}

const root = document.getElementById('root')
if (root === null) throw new Error('Missing root')
createRoot(root).render(<App />)
