import { useState, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { accepts, equal, reconcile, restoration } from './values'

// Replaced by the external bundler for this comparison host.
const reviewerOrigin = '__PREVIEW_ORIGIN__'
const cells = new Map()
let markMounted
const firstMount = new Promise(resolve => { markMounted = resolve })
let pending = null
let interacted = false
for (const type of ['pointerdown','keydown','input']) addEventListener(type,event=>{if(event.isTrusted)interacted=true},{capture:true})
function publishNavigation() {
  if (interacted && parent !== window) parent.postMessage({channel:'preview-navigation',history:structuredClone(navigation)},reviewerOrigin)
}

// An iframe's native session history is joint with every sibling iframe.
// Keep native push/replace/back semantics local to each instrumented build.
const nativeReplace = history.replaceState.bind(history)
let navigation = { entries: [{ state: history.state, path: location.pathname + location.search + location.hash }], index: 0 }
function entry(state, url) {
  const target = new URL(url ?? location.href, location.href)
  if (target.origin !== location.origin) throw new DOMException('Cross-origin history URL', 'SecurityError')
  return { state: structuredClone(state), path: target.pathname + target.search + target.hash }
}
history.pushState = (state, unused, url) => {
  const next = entry(state, url)
  nativeReplace(next.state, unused, next.path)
  navigation.entries.splice(navigation.index + 1)
  navigation.entries.push(next)
  navigation.index++
  publishNavigation()
}
history.replaceState = (state, unused, url) => {
  const next = entry(state, url)
  nativeReplace(next.state, unused, next.path)
  navigation.entries[navigation.index] = next
  publishNavigation()
}
history.go = (delta = 0) => {
  if (delta === 0) { location.reload(); return }
  const index = navigation.index + Math.trunc(delta)
  if (index < 0 || index >= navigation.entries.length) return
  navigation.index = index
  const target = navigation.entries[index]
  nativeReplace(target.state, '', target.path)
  dispatchEvent(new PopStateEvent('popstate', { state: structuredClone(target.state) }))
  publishNavigation()
}
history.back = () => history.go(-1)
history.forward = () => history.go(1)

function observe(cell) {
  useLayoutEffect(() => {
    let instances = cells.get(cell.id)
    if (instances === undefined) { instances = []; cells.set(cell.id, instances) }
    instances.push(cell)
    markMounted()
    return () => {
      const index = instances.indexOf(cell)
      if (index !== -1) instances.splice(index, 1)
      if (instances.length === 0) cells.delete(cell.id)
    }
  }, [])
}

export function useObservedState(id, schema, initial) {
  const [value, setter] = useState(() => {
    const saved = pending?.values.find(cell => cell.id === id && cell.kind === 'state')
    if (saved !== undefined && accepts(schema, saved.value)) return reconcile(saved.value, undefined, pending.context)
    return typeof initial === 'function' ? initial() : initial
  })
  const [, refresh] = useState(0)
  const token = useRef({ id, schema, kind: 'state', value,
    read() { return this.value },
    write(next) { setter(() => next); refresh(value => value + 1) },
  })
  useLayoutEffect(() => { token.current.value = value })
  observe(token.current)
  return [value, setter]
}

export function useObservedRef(id, schema, initial) {
  const ref = useRef(initial)
  const [, refresh] = useState(0)
  const mounted = useRef(false)
  if (!mounted.current && pending !== null) {
    const saved = pending.values.find(cell => cell.id === id && cell.kind === 'ref')
    if (saved !== undefined && accepts(schema, saved.value) && accepts(schema, ref.current)) ref.current = reconcile(saved.value, ref.current, pending.context)
  }
  useLayoutEffect(() => { mounted.current = true }, [])
  const token = useRef({ id, schema, kind: 'ref',
    read: () => ref.current,
    write(next) { ref.current = next; refresh(value => value + 1) },
  })
  observe(token.current)
  return ref
}

function capture() {
  const started = performance.now()
  const values = [], skipped = []
  for (const [id, instances] of cells) {
    if (instances.length !== 1) { skipped.push({ id, reason: 'multiple instances', count: instances.length }); continue }
    const cell = instances[0]
    const value = cell.read()
    if (!accepts(cell.schema, value)) {
      const root = cell.schema.nodes[cell.schema.root]
      skipped.push({ id, reason: root.kind === 'reject' ? root.reason : 'unsupported value or type' })
      continue
    }
    values.push({ id, kind: cell.kind, value })
  }
  const scroll = []
  const elements = [...document.querySelectorAll('[id]')]
  for (const element of elements) {
    if (element.clientHeight === 0 || element.scrollHeight <= element.clientHeight || !['auto', 'scroll'].includes(getComputedStyle(element).overflowY)) continue
    if (elements.filter(candidate => candidate.id === element.id).length !== 1) continue
    let anchor = null
    const bounds = element.getBoundingClientRect()
    for (const link of element.querySelectorAll('a[href]')) {
      const box = link.getBoundingClientRect()
      if (box.width === 0 || box.bottom <= bounds.top || box.top >= bounds.bottom) continue
      const url = new URL(link.href)
      if (url.origin !== location.origin) continue
      anchor = { path: url.pathname + url.search + url.hash, offset: box.top - bounds.top }
      break
    }
    scroll.push({ id: element.id, top: element.scrollTop, left: element.scrollLeft, anchor })
  }
  // Clone the complete graph once, retaining shared references across cells.
  const snapshot = structuredClone({ values, skipped, scroll, history: navigation })
  snapshot.captureMs = performance.now() - started
  return snapshot
}

function restore(snapshot) {
  const started = performance.now()
  const restored = [], rejected = [], absent = []
  for (const saved of snapshot.values) {
    const instances = cells.get(saved.id)
    if (instances === undefined) { absent.push(saved.id); continue }
    if (instances.length !== 1 || instances[0].kind !== saved.kind || !accepts(instances[0].schema, saved.value)
      || saved.kind === 'ref' && !accepts(instances[0].schema, instances[0].read())) { rejected.push(saved.id); continue }
    restored.push(saved.id)
  }
  if (rejected.length > 0) return { restored: [], rejected, absent, current: capture() }
  const validated = performance.now()
  pending = { values: snapshot.values, context: restoration() }
  function applyValues() {
    // Ref containers establish destination identities before state that may
    // point into the same graph. Native setters then schedule rendering.
    pending.context = restoration()
    for (const kind of ['ref', 'state']) {
      for (const saved of snapshot.values) {
        if (saved.kind !== kind) continue
        const instances = cells.get(saved.id)
        if (instances === undefined || instances.length !== 1) continue
        const cell = instances[0]
        if (cell.kind !== kind || !accepts(cell.schema, saved.value) || kind === 'ref' && !accepts(cell.schema, cell.read())) {
          if (!rejected.includes(saved.id)) rejected.push(saved.id)
          continue
        }
        const next = reconcile(saved.value, kind === 'ref' ? cell.read() : undefined, pending.context)
        cell.write(next)
        if (!restored.includes(saved.id)) restored.push(saved.id)
      }
    }
  }
  try {
  flushSync(applyValues)
  const firstCommit = performance.now()
  navigation = structuredClone(snapshot.history)
  const target = navigation.entries[navigation.index]
  nativeReplace(target.state, '', target.path)
  // Native route changes mount components and run their normal reset effects.
  // Restore the checkpoint after that mount, including state newly discovered there.
  const secondPass = snapshot.values.filter(saved => {
    const instances = cells.get(saved.id)
    return instances?.length === 1 && !equal(instances[0].read(), saved.value)
  }).map(saved => saved.id)
  flushSync(applyValues)
  const secondCommit = performance.now()
  const scrollRestored = []
  for (const saved of snapshot.scroll) {
    const element = document.getElementById(saved.id)
    if (element === null) { scrollRestored.push({id:saved.id,method:'absent'}); continue }
    let top = saved.top, method = 'pixels'
    if (saved.anchor !== null) {
      for (const link of element.querySelectorAll('a[href]')) {
        const url = new URL(link.href)
        if (url.origin === location.origin && url.pathname + url.search + url.hash === saved.anchor.path) {
          top = element.scrollTop + link.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.anchor.offset
          method = 'anchor'
          break
        }
      }
    }
    element.scrollTo(saved.left, top)
    scrollRestored.push({id:saved.id,method})
  }
  const current = capture()
  const changed = snapshot.values.filter(saved => {
    const actual = current.values.find(cell => cell.id === saved.id)
    return actual !== undefined && !equal(saved.value, actual.value)
  }).map(cell => cell.id)
  return { restored, rejected, absent: absent.filter(id => !restored.includes(id)), secondPass, changed, scrollRestored, current,
    timing: { validationMs: validated - started, firstCommitMs: firstCommit - validated, secondCommitMs: secondCommit - firstCommit, verificationMs: performance.now() - secondCommit } }
  } finally { pending = null }
}

globalThis.__preview = { capture, restore }

addEventListener('message', async event => {
  if (event.source !== parent || parent === window || event.origin !== reviewerOrigin) return
  const message = event.data
  if (message === null || typeof message !== 'object' || message.channel !== 'preview-state' || !Number.isSafeInteger(message.id)) return
  let result
  try {
  switch (message.operation) {
    case 'ready': await firstMount; result = { ready: cells.size > 0 }; break
    case 'capture': result = capture(); break
    case 'prepare': {
      const journal = message.snapshot
      if (!Array.isArray(journal?.entries) || !Number.isSafeInteger(journal.index) || journal.index < 0 || journal.index >= journal.entries.length) return
      const target = journal.entries[journal.index]
      if (new URL(target.path,location.href).origin!==location.origin) return
      // Discover the native route owner by its current History API value,
      // without naming an app module, field, route, or feature.
      const owners=[]
      for(const instances of cells.values()) {
        if(instances.length===1&&instances[0].kind==='state'&&accepts(instances[0].schema,instances[0].read())&&equal(instances[0].read(),history.state))owners.push(instances[0])
      }
      if(owners.length!==1||!accepts(owners[0].schema,target.state)){result={navigated:false};break}
      navigation=structuredClone(journal)
      nativeReplace(target.state,'',target.path)
      // Hidden builds may never receive animation frames. Commit the route
      // before acknowledging preparation so newly mounted owners are present.
      flushSync(() => dispatchEvent(new PopStateEvent('popstate',{state:structuredClone(target.state)})))
      result={navigated:true}
      break
    }
    case 'restore': {
      const snapshot = message.snapshot
      if (!Array.isArray(snapshot?.values) || snapshot.values.length > 2000 || !Array.isArray(snapshot.scroll) || !Array.isArray(snapshot.history?.entries)) return
      if (!Number.isSafeInteger(snapshot.history.index) || snapshot.history.index < 0 || snapshot.history.index >= snapshot.history.entries.length) return
      for (const entry of snapshot.history.entries) {
        if (typeof entry.path !== 'string' || new URL(entry.path, location.href).origin !== location.origin) return
      }
      result = await restore(snapshot)
      break
    }
    default: return
  }
  parent.postMessage({ channel: 'preview-state', id: message.id, result }, event.origin)
  } catch (error) {
    parent.postMessage({ channel: 'preview-state', id: message.id, error: error instanceof Error ? error.message : String(error) }, event.origin)
  }
})
