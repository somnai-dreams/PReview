import { useState, useLayoutEffect, useRef } from 'react'

// Replaced by the external bundler for this comparison host.
const reviewerOrigin = '__PREVIEW_ORIGIN__'
const cells = new Map()
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

function accepts(schema, value, id = schema.root, depth = 0) {
  if (depth > 100) return false
  const shape = schema.nodes[id]
  switch (shape.kind) {
    case 'reject': return false
    case 'primitive': return typeof value === shape.name && (shape.name !== 'number' || Number.isFinite(value))
    case 'literal': return value === shape.value
    case 'union': return shape.members.some(member => accepts(schema, value, member, depth + 1))
    case 'array': return Array.isArray(value) && value.every(item => accepts(schema, item, shape.item, depth + 1))
    case 'set': return value instanceof Set && [...value].every(item => accepts(schema, item, shape.item, depth + 1))
    case 'object': {
      if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
      for (const field of shape.fields) {
        if (!Object.hasOwn(value, field.name) && field.optional) continue
        if (!accepts(schema, value[field.name], field.shape, depth + 1)) return false
      }
      for (const key of Object.keys(value)) {
        if (shape.fields.some(field => field.name === key)) continue
        if (shape.index === null || !accepts(schema, value[key], shape.index, depth + 1)) return false
      }
      return true
    }
  }
}

export function useObservedState(id, schema, initial) {
  const [value, setter] = useState(() => {
    const saved = pending?.values.find(cell => cell.id === id)
    if (saved !== undefined && accepts(schema, saved.value)) return structuredClone(saved.value)
    return typeof initial === 'function' ? initial() : initial
  })
  const token = useRef({ id, schema, value, setter })
  useLayoutEffect(() => {
    token.current.value = value
    let instances = cells.get(id)
    if (instances === undefined) { instances = []; cells.set(id, instances) }
    if (!instances.includes(token.current)) instances.push(token.current)
    return () => {
      const index = instances.indexOf(token.current)
      if (index !== -1) instances.splice(index, 1)
      if (instances.length === 0) cells.delete(id)
    }
  }, [value])
  return [value, setter]
}

function capture() {
  const values = [], skipped = []
  for (const [id, instances] of cells) {
    if (instances.length !== 1) { skipped.push({ id, reason: 'multiple instances', count: instances.length }); continue }
    const cell = instances[0]
    if (!accepts(cell.schema, cell.value)) {
      const root = cell.schema.nodes[cell.schema.root]
      skipped.push({ id, reason: root.kind === 'reject' ? root.reason : 'unsupported value or type' })
      continue
    }
    values.push({ id, value: structuredClone(cell.value) })
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
  return { values, skipped, scroll, history: structuredClone(navigation) }
}

function equal(a, b) {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (a instanceof Set || b instanceof Set) return a instanceof Set && b instanceof Set && a.size === b.size && [...a].every(value => [...b].some(other => equal(value, other)))
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}

const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

async function restore(snapshot) {
  const restored = [], rejected = [], absent = []
  for (const saved of snapshot.values) {
    const instances = cells.get(saved.id)
    if (instances === undefined) { absent.push(saved.id); continue }
    if (instances.length !== 1 || !accepts(instances[0].schema, saved.value)) { rejected.push(saved.id); continue }
    restored.push(saved.id)
  }
  if (rejected.length > 0) return { restored: [], rejected, absent, current: capture() }
  pending = snapshot
  for (const saved of snapshot.values) {
    if (restored.includes(saved.id)) cells.get(saved.id)[0].setter(() => structuredClone(saved.value))
  }
  navigation = structuredClone(snapshot.history)
  const target = navigation.entries[navigation.index]
  nativeReplace(target.state, '', target.path)
  await paint()
  // Native route changes mount components and run their normal reset effects.
  // Restore the checkpoint after that mount, including state newly discovered there.
  const secondPass = []
  for (const saved of snapshot.values) {
    const instances = cells.get(saved.id)
    if (instances === undefined || instances.length !== 1) continue
    const cell = instances[0]
    if (!accepts(cell.schema, saved.value)) { rejected.push(saved.id); continue }
    if (!equal(cell.value, saved.value)) {
      cell.setter(() => structuredClone(saved.value))
      secondPass.push(saved.id)
    }
    if (!restored.includes(saved.id)) restored.push(saved.id)
  }
  await paint()
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
  await paint()
  pending = null
  const current = capture()
  const changed = snapshot.values.filter(saved => {
    const actual = current.values.find(cell => cell.id === saved.id)
    return actual !== undefined && !equal(saved.value, actual.value)
  }).map(cell => cell.id)
  return { restored, rejected, absent: absent.filter(id => !restored.includes(id)), secondPass, changed, scrollRestored, current }
}

globalThis.__preview = { capture, restore }

addEventListener('message', async event => {
  if (event.source !== parent || parent === window || event.origin !== reviewerOrigin) return
  const message = event.data
  if (message === null || typeof message !== 'object' || message.channel !== 'preview-state' || !Number.isSafeInteger(message.id)) return
  let result
  switch (message.operation) {
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
        if(instances.length===1&&accepts(instances[0].schema,instances[0].value)&&equal(instances[0].value,history.state))owners.push(instances[0])
      }
      if(owners.length!==1||!accepts(owners[0].schema,target.state)){result={navigated:false};break}
      navigation=structuredClone(journal)
      nativeReplace(target.state,'',target.path)
      dispatchEvent(new PopStateEvent('popstate',{state:structuredClone(target.state)}))
      await paint()
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
})
