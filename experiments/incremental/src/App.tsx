import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

declare const BUILD_VARIANT: string
type Row = { id: number; title: string; selected: boolean; content: string }
const initial = { rows: Array.from({ length: 20_000 }, (_, id) => ({ id, title: 'Item ' + id, selected: false, content: 'x'.repeat(2048) })) }
const original = initial.rows[0]!
function App() {
  const feed = useRef<{rows:Row[]}>(initial)
  const [draft, setDraft] = useState('Draft')
  const [selected, setSelected] = useState<Row | null>(null)
  const [render, setRender] = useState(0)
  const [writeMs, setWriteMs] = useState(0)
  return <main style={{margin:'60px auto',maxWidth:800,font:'16px system-ui',display:'grid',gap:16}}>
    <h1>Incremental comparison · {BUILD_VARIANT}</h1>
    <label>Draft <input value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <output>Rows: {feed.current.rows.length}; first: {feed.current.rows[0]!.title}; selected: {String(feed.current.rows[0]!.selected)}; render: {render}</output>
    <button onClick={() => { const started = performance.now(); for (const row of feed.current.rows) { const title = row.title; row.title = title }; setWriteMs(performance.now() - started) }}>Repeat 20,000 same-value writes</button>
    <output>Write loop: {writeMs.toFixed(2)} ms</output>
    <button onClick={() => { original.title = 'Edited through old alias' }}>Edit old alias without rendering</button>
    <button onClick={() => { feed.current.rows[0]!.selected = !feed.current.rows[0]!.selected }}>Toggle a nested value without rendering</button>
    <button onClick={() => setRender(value => value + 1)}>Render current values</button>
    <button onClick={() => setSelected(feed.current.rows[0]!)}>Open selected row</button>
    {selected === null ? null : <aside role="dialog"><p>{selected.title}</p><p>Shared identity: {String(selected === feed.current.rows[0])}</p><button onClick={() => setSelected(null)}>Close</button></aside>}
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
