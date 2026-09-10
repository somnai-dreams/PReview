import { useState, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { accepts, equal } from './values'
import { bridge, advanceRenderRevision } from './react-state'
import { commitCells } from './transfer/cell-commit'

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
let markMounted
const firstMount = new Promise(resolve => { markMounted = resolve })
let pending = null
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
      instances.splice(instances.indexOf(cell), 1)
      if (instances.length === 0) cells.delete(cell.id)
    }
  }, [])
}
function validPending(schema, value) {
  const phase = bridge.connection().graph.begin()
  try { const valid = phase.accepts(schema, value); if (valid) phase.commit(); else phase.abort(); return valid }
  finally { phase.close() }
}
export function useObservedState(id, schema, initial) {
  const [value, setter] = useState(() => {
    const saved = pending?.find(cell => cell.id === id && cell.kind === 'state')
    if (saved !== undefined && validPending(schema, saved.value)) return saved.value
    return typeof initial === 'function' ? initial() : initial
  })
  const [, refresh] = useState(0)
  const rendered = { value, version: bridge.version(value) }
  const token = useRef({ id, schema, kind: 'state', value, rendered,
    read() { return this.value },
    stale() { return !Object.is(this.rendered.value, this.value) || this.rendered.version !== bridge.version(this.value) },
    write(next) { setter(() => next); refresh(value => value + 1) },
  })
  useLayoutEffect(() => { token.current.value = value; token.current.rendered = rendered })
  observe(token.current)
  return [value, setter]
}
export function useObservedRef(id, schema, initial) {
  const ref = useRef(initial), mounted = useRef(false)
  const [, refresh] = useState(0)
  if (!mounted.current && pending !== null) {
    const saved = pending.find(cell => cell.id === id && cell.kind === 'ref')
    if (saved !== undefined && validPending(schema, saved.value) && accepts(schema, ref.current)) ref.current = saved.value
  }
  useLayoutEffect(() => { mounted.current = true }, [])
  const rendered = { value: ref.current, version: bridge.version(ref.current) }
  const token = useRef({ id, schema, kind: 'ref', rendered,
    read: () => ref.current,
    stale() { return !Object.is(this.rendered.value, ref.current) || this.rendered.version !== bridge.version(ref.current) },
    write(next) { ref.current = next; refresh(value => value + 1) },
  })
  useLayoutEffect(() => { token.current.rendered = rendered })
  observe(token.current)
  return ref
}
function mountedCells() { return [...cells.values()].flat() }
function view() { return mountedCells().map(cell => ({ id: cell.id, kind: cell.kind, schema: cell.schema, value: cell.read(), owner: cell })) }
function captureContext() {
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
  return { scroll, history: navigation, session }
}
function historyBoundary(journal) {
  if (journal === null || typeof journal !== 'object' || !Array.isArray(journal.entries) || journal.entries.length === 0 || !Number.isSafeInteger(journal.index) || journal.index < 0 || journal.index >= journal.entries.length) throw Error('Invalid navigation history')
  for (const entry of journal.entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || new URL(entry.path, location.href).origin !== location.origin) throw Error('Invalid navigation path')
  }
  return journal
}
function contextBoundary(context) {
  if (context === null || typeof context !== 'object') throw Error('Missing transfer context')
  requireSession(context.session)
  historyBoundary(context.history)
  if (!Array.isArray(context.scroll)) throw Error('Invalid scroll positions')
  const ids = new Set()
  for (const entry of context.scroll) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || ids.has(entry.id) || !Number.isFinite(entry.top) || !Number.isFinite(entry.left)) throw Error('Invalid scroll position')
    ids.add(entry.id)
    if (entry.anchor !== null && (typeof entry.anchor !== 'object' || typeof entry.anchor.path !== 'string' || !Number.isFinite(entry.anchor.offset) || new URL(entry.anchor.path, location.href).origin !== location.origin)) throw Error('Invalid scroll anchor')
  }
  return context
}
function restoreScroll(snapshot) {
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
  return scrollRestored
}
function applyPacket(packet, snapshot) {
  if (!Array.isArray(packet?.names) || packet.names.length > 2000) throw Error('Invalid named cells')
  const { graph, session: transfer, writer } = bridge.connection()
  const started = performance.now()
  const restored = transfer.receive(packet, view(), bridge.observed(), writer, values => commitCells(graph, values, {
    cells: mountedCells, commit(write) { advanceRenderRevision(); flushSync(write) }, pending(values) { pending = values }, observed: bridge.observed,
    afterFirstCommit() {
      navigation = snapshot.history
      const target = navigation.entries[navigation.index]
      nativeReplace(target.state, '', target.path)
    },
  }, writer))
  const application = restored.application
  const accepted = restored.receipt.outcome === 'accepted'
  return { receipt: restored.receipt, report: {
    retry: restored.retry === 'full' || restored.receipt.outcome === 'retry',
    restored: application?.restored ?? [], absent: application?.absent ?? restored.absent ?? [],
    rejected: accepted ? [] : application?.issues.length ? application.issues.map(issue => issue.id) : ['transfer'],
    rejectionDetails: application?.issues ?? [], error: restored.error,
    secondPass: application?.secondPass ?? [], changed: application?.changed ?? [], skipped: [],
    retained: restored.values?.filter(value => !value.changed).length ?? 0,
    transferred: restored.values?.filter(value => value.changed).length ?? 0,
    repairMode: application?.repairMode, journalObjects: application?.journalObjects, snapshotObjects: application?.snapshotObjects,
    scrollRestored: accepted ? restoreScroll(snapshot) : [], incremental: bridge.stats(),
    timing: { restoreMs: performance.now() - started },
  } }
}

// One bounded inbox for the offer -> packet -> receipt exchange. It is installed
// before authentication, and owns the port and timeout for exactly one command.
function peerChannel(port) {
  let waiting = null, queued = null, failure = null, closed = false
  function fail(error) { failure = error; if (waiting !== null) { waiting.reject(error); waiting = null } }
  const timer = setTimeout(() => fail(Error('Build transfer timed out')), 60000)
  port.onmessage = event => {
    const value = event.data
    if (value === null || typeof value !== 'object') { fail(Error('Invalid transfer message')); return }
    if (typeof value.error === 'string') { fail(Error(value.error)); return }
    if (waiting !== null) { const resolve = waiting.resolve; waiting = null; resolve(value) }
    else if (queued === null) queued = value
    else fail(Error('Unexpected transfer message'))
  }
  port.onmessageerror = () => fail(Error('Invalid transfer message'))
  port.start()
  return {
    read() {
      if (failure !== null) return Promise.reject(failure)
      if (closed || waiting !== null) return Promise.reject(Error('Invalid transfer phase'))
      if (queued !== null) { const value = queued; queued = null; return Promise.resolve(value) }
      return new Promise((resolve, reject) => { waiting = { resolve, reject } })
    },
    post(value) { if (failure !== null) throw failure; if (closed) throw Error('Transfer is closed'); port.postMessage(value) },
    error(message) { if (!closed) port.postMessage({ error: message }) },
    close() { closed = true; clearTimeout(timer); port.onmessage = null; port.onmessageerror = null; port.close(); queued = null; fail(Error('Transfer closed')) },
  }
}
addEventListener('message', async event => {
  if (event.source !== parent || parent === window || event.origin !== reviewerOrigin) return
  const message = event.data
  if (message === null || typeof message !== 'object' || message.channel !== 'preview-state' || !Number.isSafeInteger(message.id)) return
  const transferring = message.operation === 'capture' || message.operation === 'restore'
  const peer = transferring && event.ports?.length === 1 ? peerChannel(event.ports[0]) : null
  // Handle errors immediately even while the account check is pending.
  const incoming = peer?.read(); incoming?.catch(() => {})
  const receivedAt = performance.now()
  let authorizedAt = null, payloadAt = receivedAt, operationAt = null, operationMs = 0, receiptWaitMs = 0, requestId = null
  const timing = () => ({ sessionMs: (authorizedAt ?? performance.now()) - receivedAt, payloadWaitMs: payloadAt - receivedAt, operationMs, receiptWaitMs })
  try {
    if (transferring && peer === null) throw Error('Transfer requires a private peer channel')
    const authorization = checkSession().finally(() => { authorizedAt = performance.now() })
    let result
    switch (message.operation) {
      case 'ready': {
        await authorization
        const configuration = message.snapshot
        if (configuration === null || typeof configuration !== 'object' || typeof configuration.scope !== 'string') throw Error('Missing comparison identity')
        bridge.configure(configuration.scope, configuration.site)
        await firstMount
        result = { ready: cells.size > 0, incremental: bridge.stats() }
        break
      }
      case 'engine': {
        await authorization
        if (message.snapshot !== 'full' && message.snapshot !== 'incremental') throw Error('Invalid comparison engine')
        bridge.engine(message.snapshot); result = bridge.stats(); break
      }
      case 'capture': {
        const [, ready] = await Promise.all([authorization, incoming])
        payloadAt = performance.now()
        if (ready.kind !== 'offer') throw Error('Expected destination offer')
        requireSession(ready.session)
        const transfer = bridge.connection().session
        const receipt = peer.read(); receipt.catch(() => {})
        operationAt = performance.now()
        const context = captureContext()
        const sent = transfer.send(ready.offer, view(), bridge.observed(), { postMessage(packet) { peer.post({ kind: 'packet', packet, context }) } })
        requestId = sent.id
        operationMs = performance.now() - operationAt
        const waitingAt = performance.now()
        const reply = await receipt
        receiptWaitMs = performance.now() - waitingAt
        if (reply.kind !== 'receipt' || !transfer.acknowledge(reply.receipt)) throw Error('Unexpected transfer receipt')
        result = { ...sent, captureMs: operationMs, incremental: bridge.stats(), captureDetails: { ...sent.captureDetails, heapBytes: performance.memory?.usedJSHeapSize } }
        break
      }
      case 'restore': {
        await authorization
        const transfer = bridge.connection().session
        const offer = transfer.offer(view(), bridge.observed()); requestId = offer.id
        peer.post({ kind: 'offer', offer, session })
        const payload = await incoming; payloadAt = performance.now()
        if (payload.kind !== 'packet') throw Error('Expected source packet')
        const context = contextBoundary(payload.context)
        operationAt = performance.now()
        const restored = applyPacket(payload.packet, context)
        operationMs = performance.now() - operationAt
        peer.post({ kind: 'receipt', receipt: restored.receipt })
        result = restored.report
        break
      }
      case 'prepare': {
        await authorization
        operationAt = performance.now()
        const journal = message.snapshot
        requireSession(journal?.session)
        historyBoundary(journal)
        const target = journal.entries[journal.index], owners = []
        for (const instances of cells.values()) {
          if (instances.length === 1 && instances[0].kind === 'state' && accepts(instances[0].schema, instances[0].read()) && equal(instances[0].read(), history.state)) owners.push(instances[0])
        }
        if (owners.length !== 1 || !accepts(owners[0].schema, target.state)) { result = { navigated: false }; break }
        navigation = { entries: journal.entries, index: journal.index }
        nativeReplace(target.state, '', target.path)
        flushSync(() => dispatchEvent(new PopStateEvent('popstate', { state: structuredClone(target.state) })))
        result = { navigated: true }
        operationMs = performance.now() - operationAt
        break
      }
      default: await authorization; return
    }
    parent.postMessage({ channel: 'preview-state', id: message.id, result, timing: timing() }, event.origin)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    peer?.error(messageText)
    parent.postMessage({ channel: 'preview-state', id: message.id, error: messageText, timing: timing() }, event.origin)
  } finally {
    if (requestId !== null) bridge.connection().session.cancel(requestId)
    peer?.close()
  }
})
