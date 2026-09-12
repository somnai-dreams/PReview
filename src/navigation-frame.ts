// Self-contained so a gateway can serve this function before application code.
// Only paths and opaque entry keys cross the frame boundary. Route state stays here.
export function installNavigationFrame(options: { reviewer: string; build: string }) {
  if (parent === window) return
  type Route = { path: string; state: unknown }
  type Entry = { key: string; route: Route }
  const nativeReplace = history.replaceState.bind(history)
  function path() {
    const url = new URL(location.href)
    if (url.searchParams.has('__preview_build')) url.searchParams.delete('__preview_build')
    return url.pathname + url.search + url.hash
  }
  function route(state: unknown, value?: string | URL | null): Route {
    const url = new URL(value ?? location.href, location.href)
    if (url.origin !== location.origin) throw new DOMException('Cross-origin history URL', 'SecurityError')
    if (url.searchParams.has('__preview_build')) url.searchParams.delete('__preview_build')
    return { path: url.pathname + url.search + url.hash, state: structuredClone(state) }
  }
  let entries: Entry[] = [{ key: crypto.randomUUID(), route: route(history.state) }], index = 0
  let connected = false, active = false
  let arriving: { key: string; path: string } | null = null
  const current = () => entries[index]!
  function send(message: object) { parent.postMessage({ channel: 'preview-navigation', build: options.build, ...message }, options.reviewer) }
  function changed(kind: 'push' | 'replace') {
    if (connected) send({ kind, key: current().key, path: path() })
  }
  history.pushState = (state, unused, value) => {
    const next = route(state, value)
    nativeReplace(next.state, unused, next.path)
    entries.splice(index + 1)
    entries.push({ key: crypto.randomUUID(), route: next }); index++
    changed('push')
  }
  history.replaceState = (state, unused, value) => {
    const next = route(state, value)
    nativeReplace(next.state, unused, next.path)
    current().route = next
    changed('replace')
  }
  function restoreEntry(next: number) {
    const previous = location.href
    index = next
    const saved = current().route
    nativeReplace(saved.state, '', saved.path)
    dispatchEvent(new PopStateEvent('popstate', { state: structuredClone(saved.state) }))
    if (new URL(previous).hash !== location.hash) {
      dispatchEvent(new HashChangeEvent('hashchange', { oldURL: previous, newURL: location.href }))
    }
  }
  history.go = (delta = 0) => {
    if (delta === 0) { location.reload(); return }
    if (connected) { if (active) send({ kind: 'traverse', delta: Math.trunc(delta) }); return }
    const next = index + Math.trunc(delta)
    if (next >= 0 && next < entries.length) restoreEntry(next)
  }
  history.back = () => history.go(-1)
  history.forward = () => history.go(1)
  // The state-transfer runtime shares this owner instead of installing a second
  // history journal over it. The exported journal contains no host entry keys.
  const target = globalThis as typeof globalThis & { __previewNavigation?: {
    history: () => { entries: Route[]; index: number }
    restore: (journal: { entries: Route[]; index: number }) => void
  } }
  target.__previewNavigation = {
    history: () => ({ entries: entries.map(entry => entry.route), index }),
    restore(journal) {
      entries = journal.entries.map(saved => ({ key: crypto.randomUUID(), route: saved }))
      index = journal.index
      const saved = current().route
      nativeReplace(saved.state, '', saved.path)
      changed('replace')
    },
  }
  function requestNavigation(url: URL) {
    if (url.searchParams.has('__preview_build')) url.searchParams.delete('__preview_build')
    send({ kind: 'navigate', key: crypto.randomUUID(), path: url.pathname + url.search + url.hash })
  }
  // Leave client routers first refusal. Ordinary links then take the same path
  // as script-driven document navigation, using replacement loads in the frame.
  document.addEventListener('click', event => {
    if (!connected || !active || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = event.composedPath().find(item => item instanceof HTMLAnchorElement)
    if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download') || (link.target !== '' && link.target !== '_self')) return
    const url = new URL(link.href)
    if (url.origin !== location.origin) return
    event.preventDefault(); requestNavigation(url)
  })
  // The Navigation API also covers location.assign(), location.hash and GET
  // forms. POST bodies and external destinations retain native browser handling.
  type NavigateEvent = Event & { navigationType: string; canIntercept: boolean; formData: FormData | null; destination: { url: string; sameDocument: boolean }; hashChange: boolean; downloadRequest: string | null }
  const navigation = (window as Window & { navigation?: EventTarget }).navigation
  navigation?.addEventListener('navigate', raw => {
    const event = raw as NavigateEvent, url = new URL(event.destination.url)
    if (!connected || !active || event.defaultPrevented || event.navigationType !== 'push' || !event.canIntercept || event.formData !== null || event.downloadRequest !== null || url.origin !== location.origin || event.destination.sameDocument && !event.hashChange) return
    event.preventDefault(); requestNavigation(url)
  })
  addEventListener('message', event => {
    const message: unknown = event.data
    if (event.source !== parent || event.origin !== options.reviewer || message === null || typeof message !== 'object') return
    const data = message as Record<string, unknown>
    if (data['channel'] !== 'preview-navigation' || data['build'] !== options.build) return
    switch (data['kind']) {
      case 'connect':
        if (typeof data['key'] !== 'string' || typeof data['active'] !== 'boolean') return
        connected = true; active = data['active']; current().key = data['key']
        send({ kind: 'ready', key: current().key, path: path() })
        break
      case 'active':
        if (typeof data['active'] === 'boolean') active = data['active']
        break
      case 'navigate': {
        if (typeof data['key'] !== 'string' || typeof data['path'] !== 'string') return
        const url = new URL(data['path'], location.origin)
        if (!data['path'].startsWith('/') || data['path'].startsWith('//') || url.origin !== location.origin) return
        const key = data['key'], next = data['path']
        const saved = entries.findIndex(entry => entry.key === key && entry.route.path === next)
        if (saved >= 0) {
          restoreEntry(saved)
          send({ kind: 'ready', key, path: path() })
        } else if (path() === next) {
          current().key = key
          send({ kind: 'ready', key, path: path() })
        } else {
          arriving = { key, path: next }
          url.searchParams.set('__preview_build', options.build)
          location.replace(url.href)
        }
        break
      }
      case 'hello': send({ kind: 'hello' }); break
    }
  })
  addEventListener('hashchange', () => {
    if (arriving !== null && path() === arriving.path) {
      entries.splice(index + 1); entries.push({ key: arriving.key, route: route(history.state) }); index++
      arriving = null
      send({ kind: 'ready', key: current().key, path: path() })
    }
  })
  send({ kind: 'hello' })
}
