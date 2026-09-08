import { useState, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { accepts, equal, comparison, checkpointValidation, reconcile, restoration } from './values'
import { retainedCells, encodeValues, decodeValues } from './checkpoint'

// Replaced by the external bundler for this comparison host.
const reviewerOrigin = '__PREVIEW_ORIGIN__'
// A deployment may supply an account/environment check. It must reject stale
// page sessions; credentials never enter the checkpoint or parent frame.
const authorizeSession = null
let session = null
async function checkSession() {
  if (authorizeSession === null) return
  const next = await authorizeSession()
  if (next === null || typeof next !== 'object' || typeof next.account !== 'string' || next.account === '' || typeof next.environment !== 'string' || next.environment === '') throw new Error('Sign in to this build and reload it')
  if (session !== null && (session.account !== next.account || session.environment !== next.environment)) throw new Error('Build account changed; reload before comparing')
  session = { account: next.account, environment: next.environment }
}
function requireSession(saved) {
  if (session === null ? saved !== null : saved === null || saved?.account !== session.account || saved?.environment !== session.environment) throw new Error('Build accounts or environments do not match')
}
const cells = new Map()
const validation = checkpointValidation()
const incremental = globalThis.__previewIncremental ?? null
let markMounted
const firstMount = new Promise(resolve => { markMounted = resolve })
let pending = null
let checkpoint = null
let interacted = false
for (const type of ['pointerdown','keydown','input']) addEventListener(type,event=>{if(event.isTrusted)interacted=true},{capture:true})
function publishNavigation() {
  if (interacted && parent !== window) parent.postMessage({channel:'preview-navigation',history:{...structuredClone(navigation),session}},reviewerOrigin)
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
    if (saved !== undefined && validation.accepts(schema, saved.value)) return reconcile(saved.value, undefined, pending.context)
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
    if (saved !== undefined && validation.accepts(schema, saved.value) && accepts(schema, ref.current)) ref.current = reconcile(saved.value, ref.current, pending.context)
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
  const candidates = []
  for (const [id, instances] of cells) {
    if (instances.length === 1) candidates.push({ id, kind: instances[0].kind, value: instances[0].read(), owner: instances[0] })
  }
  const previous = checkpoint === null ? [] : checkpoint.snapshot.values.map(saved => ({ ...saved, owner: checkpoint.owners.get(saved.id) }))
  const { retained, reverse } = checkpoint === null ? { retained: new Set(), reverse: new Map() } : retainedCells(previous, candidates, incremental?.phase())
  const comparisonMs = performance.now() - started
  const priorValues = new Map(previous.map(saved => [saved.id, saved]))
  const owners = new Map()
  for (const [id, instances] of cells) {
    if (instances.length !== 1) { skipped.push({ id, reason: 'multiple instances', count: instances.length }); continue }
    const cell = instances[0]
    const value = cell.read()
    const matched = reverse.get(value)
    if (!retained.has(id) && !(matched === undefined ? accepts(cell.schema, value) : validation.accepts(cell.schema, matched))) {
      const root = cell.schema.nodes[cell.schema.root]
      skipped.push({ id, reason: root.kind === 'reject' ? root.reason : 'unsupported value or type' })
      continue
    }
    values.push({ id, kind: cell.kind, value })
    owners.set(id, cell)
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
  // Copy changed data and reconnect its references to the retained checkpoint.
  const changedValues = values.filter(saved => !retained.has(saved.id))
  const baseObjects = checkpoint?.snapshot.values.map(saved => saved.value) ?? []
  const encoded = encodeValues(changedValues.map(saved => saved.value), baseObjects, reverse)
  const decoded = decodeValues(encoded.values, encoded.references, baseObjects)
  const snapshot = structuredClone({ skipped, scroll, history: navigation, session })
  snapshot.values = changedValues.map((saved, index) => ({ ...saved, value: decoded[index] }))
  const changed = new Map(snapshot.values.map(saved => [saved.id, saved]))
  const encodedById = new Map(changedValues.map((saved, index) => [saved.id, { ...saved, value: encoded.values[index] }]))
  const entries = values.map(saved => retained.has(saved.id) ? { id: saved.id, kind: saved.kind, reuse: true } : encodedById.get(saved.id))
  snapshot.values = values.map(saved => retained.has(saved.id) ? { id: saved.id, kind: saved.kind, value: priorValues.get(saved.id).value } : changed.get(saved.id))
  for (const saved of snapshot.values) validation.remember(owners.get(saved.id).schema, saved.value)
  incremental?.keep(snapshot.values.map(saved => ({ source: saved.value, target: owners.get(saved.id).read() })))
  snapshot.captureMs = performance.now() - started
  snapshot.comparisonMs = comparisonMs
  snapshot.incremental = incremental?.stats()
  const base = checkpoint?.id ?? null, id = crypto.randomUUID()
  checkpoint = { id, snapshot, owners }
  return { ...snapshot, values: entries, references: encoded.references, base, id }
}

function restore(packet) {
  const started = performance.now()
  if (typeof packet.id !== 'string' || !(packet.base === null || typeof packet.base === 'string')) throw new Error('Invalid checkpoint identity')
  if (packet.base === null && (packet.values.some(saved => saved.reuse === true) || packet.references?.length)) throw new Error('A full checkpoint cannot contain references')
  if (packet.base !== null && checkpoint?.id !== packet.base) return { needsFull: true }
  const changedValues = packet.values.filter(saved => saved.reuse !== true)
  const decoded = decodeValues(changedValues.map(saved => saved.value), packet.references ?? [], checkpoint?.snapshot.values.map(saved => saved.value) ?? [])
  const decodedById = new Map(changedValues.map((saved, index) => [saved.id, { ...saved, value: decoded[index] }]))
  const old = new Map(checkpoint?.snapshot.values.map(saved => [saved.id, saved]) ?? [])
  const reused = new Set()
  const values = packet.values.map(saved => {
    if (saved.reuse !== true) return decodedById.get(saved.id)
    const previous = old.get(saved.id)
    if (previous === undefined || previous.kind !== saved.kind) throw new Error('Invalid checkpoint reference')
    reused.add(saved.id)
    return previous
  })
  const snapshot = { values, scroll: packet.scroll, history: packet.history }
  const decodedAt = performance.now()
  const candidates = []
  for (const [id, instances] of cells) {
    if (instances.length === 1) candidates.push({ id, kind: instances[0].kind, value: instances[0].read(), owner: instances[0] })
  }
  const { retained, matches, reverse } = reused.size === 0 ? { retained: new Set(), matches: new Map(), reverse: new Map() } : retainedCells(
    values.map(saved => ({ ...saved, owner: reused.has(saved.id) ? checkpoint.owners.get(saved.id) : saved })), candidates, incremental?.phase())
  const restored = [], rejections = [], skipped = [], absent = [], plan = []
  for (const saved of snapshot.values) {
    const instances = cells.get(saved.id)
    if (instances === undefined) { absent.push(saved.id); continue }
    if (instances.length !== 1) { skipped.push({ id: saved.id, reason: 'multiple instances', count: instances.length }); continue }
    if (retained.has(saved.id)) { restored.push(saved.id); continue }
    const current = instances[0].read(), matched = reverse.get(current)
    const validatedBefore = reused.has(saved.id) && checkpoint.owners.get(saved.id) === instances[0]
    const reason = instances[0].kind !== saved.kind ? 'hook-kind-mismatch'
      : !validatedBefore && !validation.accepts(instances[0].schema, saved.value) ? 'incoming-value-invalid'
      : saved.kind === 'ref' && !(matched === undefined ? accepts(instances[0].schema, current) : validation.accepts(instances[0].schema, matched)) ? 'live-ref-invalid' : null
    if (reason !== null) { rejections.push({ id: saved.id, reason, phase: 'validation' }); continue }
    plan.push({ saved, cell: instances[0] })
    restored.push(saved.id)
  }
  const validated = performance.now()
  if (rejections.length > 0) return { restored: [], rejected: rejections.map(item => item.id), rejectionDetails: rejections, skipped, absent, incremental: incremental?.stats(),
    timing: { decodeMs: decodedAt - started, validationMs: validated - decodedAt, firstCommitMs: 0, secondCommitMs: 0, verificationMs: 0, restoreMs: performance.now() - started } }
  // Ambiguous owners stay local for this entire transfer, including remounts.
  const transferable = snapshot.values.filter(saved => !skipped.some(item => item.id === saved.id))
  pending = { values: transferable, context: restoration(matches, reverse) }
  function applyValues(entries) {
    // Validation precedes this synchronous commit. Refs establish canonical
    // container identities before state that may point into the same graph.
    for (const kind of ['ref', 'state']) {
      for (const { saved, cell } of entries) {
        if (saved.kind !== kind) continue
        cell.write(reconcile(saved.value, kind === 'ref' ? cell.read() : undefined, pending.context))
      }
    }
  }
  try {
  if (plan.length > 0) flushSync(() => applyValues(plan))
  const firstCommit = performance.now()
  navigation = structuredClone(snapshot.history)
  const target = navigation.entries[navigation.index]
  nativeReplace(target.state, '', target.path)
  // Mount/reset effects can introduce owners or change restored values. Repair
  // only those cells, preserving the graph identities established above.
  const repairs = [], repairComparison = comparison(pending.context.copies, incremental?.phase())
  for (const saved of transferable) {
    const instances = cells.get(saved.id)
    if (instances === undefined) continue
    // A commit may already have initialized new owners: do not claim these
    // stayed local, or silently accept an ownership change after applying state.
    if (instances.length !== 1) { rejections.push({ id: saved.id, reason: 'multiple-instances-after-commit', count: instances.length, phase: 'repair' }); continue }
    if (instances[0].kind !== saved.kind) { rejections.push({ id: saved.id, reason: 'hook-kind-mismatch', phase: 'repair' }); continue }
    const cell = instances[0]
    const known = retained.has(saved.id) && checkpoint.owners.get(saved.id) === cell || plan.some(entry => entry.saved === saved && entry.cell === cell)
    if (!known && !validation.accepts(cell.schema, saved.value)) { rejections.push({ id: saved.id, reason: 'incoming-value-invalid', phase: 'repair' }); continue }
    if (repairComparison.matches(saved.value, cell.read())) {
      if (!restored.includes(saved.id)) restored.push(saved.id)
      continue
    }
    if (saved.kind === 'ref' && !accepts(cell.schema, cell.read())) { rejections.push({ id: saved.id, reason: 'live-ref-invalid', phase: 'repair' }); continue }
    repairs.push({ saved, cell })
  }
  const secondPass = repairs.map(entry => entry.saved.id)
  const repaired = rejections.length === 0 && repairs.length > 0
  if (repaired) {
    pending.context.pass++
    flushSync(() => applyValues(repairs))
    for (const { saved } of repairs) if (!restored.includes(saved.id)) restored.push(saved.id)
  }
  const secondCommit = performance.now()
  // A commit can change any live cell. Without one, this is still the same
  // synchronous read phase: reuse its comparisons before touching scroll.
  const changed = [], verification = repaired ? comparison(pending.context.copies, incremental?.phase()) : repairComparison
  for (const saved of transferable) {
    const instances = cells.get(saved.id)
    if (instances === undefined) continue
    if (instances.length !== 1) {
      if (!rejections.some(item => item.id === saved.id)) rejections.push({ id: saved.id, reason: 'multiple-instances-after-commit', count: instances.length, phase: 'verification' })
      continue
    }
    if (!verification.matches(saved.value, instances[0].read())) changed.push(saved.id)
  }
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
  if (rejections.length === 0) checkpoint = { id: packet.id, snapshot, owners: new Map(restored.map(id => [id, cells.get(id)?.[0]])) }
  if (rejections.length === 0) incremental?.keep(snapshot.values.flatMap(saved => { const instances = cells.get(saved.id); return instances?.length === 1 && restored.includes(saved.id) && !changed.includes(saved.id) ? [{source:saved.value,target:instances[0].read()}] : [] }))
  return { incremental: incremental?.stats(), restored, rejected: rejections.map(item => item.id), rejectionDetails: rejections, skipped, absent: absent.filter(id => !restored.includes(id)), secondPass, changed, scrollRestored, retained: retained.size, transferred: values.length - reused.size,
    timing: { decodeMs: decodedAt - started, validationMs: validated - decodedAt, firstCommitMs: firstCommit - validated, secondCommitMs: secondCommit - firstCommit, verificationMs: performance.now() - secondCommit, restoreMs: performance.now() - started } }
  } finally { pending = null }
}

globalThis.__preview = { capture, restore }

addEventListener('message', async event => {
  if (event.source !== parent || parent === window || event.origin !== reviewerOrigin) return
  const message = event.data
  if (message === null || typeof message !== 'object' || message.channel !== 'preview-state' || !Number.isSafeInteger(message.id)) return
  let result
  const receivedAt = performance.now()
  let authorizedAt = null
  const timing = () => ({ sessionMs: (authorizedAt ?? performance.now()) - receivedAt, operationMs: authorizedAt === null ? 0 : performance.now() - authorizedAt })
  try {
  await checkSession()
  authorizedAt = performance.now()
  switch (message.operation) {
    case 'ready': await firstMount; result = { ready: cells.size > 0, incremental: incremental?.stats() }; break
    case 'capture': result = capture(); break
    case 'engine': {
      if (message.snapshot !== 'full' && message.snapshot !== 'incremental') throw new Error('Invalid comparison engine')
      incremental?.configure(message.snapshot)
      result = incremental?.stats() ?? { enabled:false, coverage:false }
      break
    }
    case 'checkpoint': {
      if (checkpoint === null) throw new Error('No captured checkpoint')
      result = { ...checkpoint.snapshot, id: checkpoint.id, base: null, references: [] }
      break
    }
    case 'prepare': {
      const journal = message.snapshot
      requireSession(journal?.session)
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
      navigation={entries:structuredClone(journal.entries),index:journal.index}
      nativeReplace(target.state,'',target.path)
      // Hidden builds may never receive animation frames. Commit the route
      // before acknowledging preparation so newly mounted owners are present.
      flushSync(() => dispatchEvent(new PopStateEvent('popstate',{state:structuredClone(target.state)})))
      result={navigated:true}
      break
    }
    case 'restore': {
      const snapshot = message.snapshot
      requireSession(snapshot?.session)
      if (!Array.isArray(snapshot?.values) || snapshot.values.length > 2000 || !Array.isArray(snapshot.scroll) || !Array.isArray(snapshot.history?.entries)) return
      if (!Number.isSafeInteger(snapshot.history.index) || snapshot.history.index < 0 || snapshot.history.index >= snapshot.history.entries.length) return
      for (const entry of snapshot.history.entries) {
        if (typeof entry.path !== 'string' || new URL(entry.path, location.href).origin !== location.origin) return
      }
      result = restore(snapshot)
      break
    }
    default: return
  }
  parent.postMessage({ channel: 'preview-state', id: message.id, result, timing: timing() }, event.origin)
  } catch (error) {
    parent.postMessage({ channel: 'preview-state', id: message.id, error: error instanceof Error ? error.message : String(error), timing: timing() }, event.origin)
  }
})
