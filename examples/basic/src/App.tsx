import { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

declare const BUILD_VARIANT: 'A' | 'B'

function App() {
  const [draft, setDraft] = useState('A quiet observatory above the clouds')
  const [count, setCount] = useState(0)
  const [details, setDetails] = useState(false)
  const [tone, setTone] = useState<'warm' | 'cool'>('warm')
  const rows = useRef(new Map<string, { title: string; tags: string[] }>([['one', { title: 'First item', tags: [] }]]))
  const selected = useRef(rows.current.get('one')!)
  const rememberedRows = useMemo(() => rows.current, [])
  const [, render] = useState(0)
  return <main style={{ maxWidth: 720, margin: '64px auto', padding: 24, fontFamily: 'system-ui', color: '#172129' }}>
    <p>BUILD {BUILD_VARIANT}</p>
    <h1>Same work. Different build.</h1>
    <p>Edit this draft, change the controls, then switch builds above.</p>
    <section style={{ padding: 24, borderRadius: BUILD_VARIANT === 'A' ? 4 : 24, background: tone === 'warm' ? '#fff0d8' : '#e0efff', display: 'grid', gap: 20 }}>
      <label>Draft<textarea value={draft} onChange={event => setDraft(event.target.value)} style={{ display: 'block', width: '100%', minHeight: 100, marginTop: 8, font: 'inherit' }} /></label>
      <label>Tone <select value={tone} onChange={event => setTone(event.target.value === 'warm' ? 'warm' : 'cool')}><option value="warm">Warm</option><option value="cool">Cool</option></select></label>
      <button onClick={() => setCount(value => value + 1)}>Count: {count}</button>
      <button onClick={() => setDetails(value => !value)}>{details ? 'Hide details' : 'Show details'}</button>
      {details && <Details />}
      <p>Ref item: {selected.current.title}; tags: {selected.current.tags.join(', ') || 'none'}</p>
      <p>Memoized Map size: {rememberedRows.size}</p>
      <button onClick={() => { selected.current.title = 'Edited in ' + BUILD_VARIANT; selected.current.tags.push(BUILD_VARIANT); render(value => value + 1) }}>Edit ref item</button>
      <button onClick={() => { rows.current.set(String(rows.current.size), { title: 'Added without rendering', tags: [] }) }}>Append ref without rendering</button>
    </section>
  </main>
}

function Details() {
  const [note, setNote] = useState('')
  return <label>Detail note<input value={note} onChange={event => setNote(event.target.value)} style={{ display: 'block', width: '100%', marginTop: 8, font: 'inherit' }} /></label>
}

const root = document.getElementById('root')
if (root === null) throw new Error('Missing application root')
createRoot(root).render(<App />)
