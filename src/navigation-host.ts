// Self-contained for inclusion under the reviewer's script CSP hash.
export function installNavigationHost(config: { builds: { origin: string; id: string; label: string }[] }) {
  type Route = { key: string; path: string }
  type Frame = { element: HTMLIFrameElement; button: HTMLButtonElement; ready: boolean; route: Route; timer: ReturnType<typeof setTimeout> | null }
  const frames: Frame[] = []
  const status = document.querySelector<HTMLElement>('#status')!
  const buttons = document.querySelector<HTMLElement>('#builds')!
  let active = 0
  const path = () => location.pathname + location.search + location.hash
  let route: Route = { key: crypto.randomUUID(), path: path() }
  history.replaceState(route, '', route.path)
  function checkedPath(value: unknown) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 4096) return null
    const url = new URL(value, location.origin)
    if (url.origin !== location.origin || url.pathname === '/__preview' || url.pathname.startsWith('/__preview/')) return null
    return url.pathname + url.search + url.hash
  }
  function send(index: number, message: object) {
    const build = config.builds[index]!
    frames[index]!.element.contentWindow!.postMessage({ channel: 'preview-navigation', build: build.id, ...message }, build.origin)
  }
  function loading(index: number) {
    const frame = frames[index]!
    frame.ready = false
    if (frame.timer !== null) clearTimeout(frame.timer)
    frame.timer = setTimeout(() => { if (index === active) status.textContent = 'This page has not connected. Open the build to inspect it.' }, 30000)
    if (index === active) status.textContent = 'Loading…'
  }
  function navigate(index: number) {
    const frame = frames[index]!
    frame.route = route; loading(index)
    send(index, { kind: 'navigate', ...route })
  }
  function address(next: Route, push: boolean) {
    route = next
    if (push) history.pushState(route, '', route.path)
    else history.replaceState(route, '', route.path)
  }
  addEventListener('popstate', event => {
    const state: unknown = (event as PopStateEvent).state
    const data = state !== null && typeof state === 'object' ? state as Record<string, unknown> : null
    route = { key: typeof data?.['key'] === 'string' ? data['key'] : crypto.randomUUID(), path: path() }
    navigate(active)
  })
  // A fragment typed into the outer address bar can create a native entry.
  addEventListener('hashchange', () => {
    if (route.path === path()) return
    address({ key: crypto.randomUUID(), path: path() }, false); navigate(active)
  })
  addEventListener('message', event => {
    const index = config.builds.findIndex((build, index) => event.origin === build.origin && event.source === frames[index]!.element.contentWindow)
    const message: unknown = event.data
    if (index < 0 || message === null || typeof message !== 'object') return
    const data = message as Record<string, unknown>, frame = frames[index]!
    if (data['channel'] !== 'preview-navigation' || data['build'] !== config.builds[index]!.id) return
    if (data['kind'] === 'hello') {
      send(index, { kind: 'connect', key: frame.route.key, active: index === active }); return
    }
    if (data['kind'] === 'traverse') {
      if (index === active && Number.isSafeInteger(data['delta']) && (data['delta'] as number) !== 0) history.go(data['delta'] as number)
      return
    }
    const nextPath = checkedPath(data['path']), key = data['key']
    if (nextPath === null || typeof key !== 'string' || key.length > 100) return
    const next = { key, path: nextPath }
    switch (data['kind']) {
      case 'ready':
        if (key !== frame.route.key) return
        frame.ready = true; frame.route = next
        if (frame.timer !== null) { clearTimeout(frame.timer); frame.timer = null }
        if (index === active) { address(next, false); status.textContent = 'Ready' }
        break
      case 'push':
      case 'replace':
        frame.route = next
        if (index === active) address(next, data['kind'] === 'push')
        break
      case 'navigate':
        if (index !== active) return
        address(next, true); navigate(index)
        break
    }
  })
  for (let index = 0; index < config.builds.length; index++) {
    const build = config.builds[index]!, element = document.createElement('iframe'), button = document.createElement('button')
    const frame: Frame = { element, button, ready: false, route, timer: null }
    frames.push(frame)
    element.title = build.label; element.classList.toggle('active', index === active)
    button.textContent = build.label; button.setAttribute('aria-pressed', String(index === active))
    button.onclick = () => {
      if (index === active) return
      const previous = frames[active]!
      previous.element.classList.remove('active'); previous.button.setAttribute('aria-pressed', 'false')
      send(active, { kind: 'active', active: false })
      active = index
      element.classList.add('active'); button.setAttribute('aria-pressed', 'true')
      send(index, { kind: 'active', active: true })
      if (frame.ready) navigate(index)
      else {
        frame.route = route; loading(index)
        // Replacement loads never add hidden-frame entries to browser history.
        element.contentWindow!.location.replace(buildURL())
      }
    }
    const inspect = document.createElement('a')
    inspect.textContent = 'Open ' + (index === 0 ? 'A' : 'B'); inspect.target = '_blank'; inspect.rel = 'noopener'
    function buildURL() { const url = new URL(route.path, build.origin); url.searchParams.set('__preview_build', build.id); return url.href }
    inspect.href = buildURL()
    inspect.addEventListener('click', () => { inspect.href = buildURL() })
    buttons.append(button, inspect)
    element.addEventListener('load', () => { send(index, { kind: 'hello' }) })
    element.src = buildURL(); document.body.append(element); loading(index)
  }
}
