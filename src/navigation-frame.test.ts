import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { installNavigationFrame } from './navigation-frame'

test('navigation owns frame history, keeps route state local and authenticates host commands', () => {
  const messages: Record<string, unknown>[] = [], events: { type: string; state: unknown }[] = []
  const listeners: Record<string, (event: object) => void> = {}
  let url = new URL('https://a.example/start?__preview_build=a'), state: unknown = null, replacements = 0
  const parent = { postMessage(message: Record<string, unknown>, origin: string) { expect(origin).toBe('https://review.example'); messages.push(message) } }
  const history = {
    get state() { return state },
    replaceState(next: unknown, _unused: string, path: string) { state = next; url = new URL(path, url); replacements++ },
    pushState(_state: unknown, _unused: string, _path: string) { throw Error('Native iframe push must not run') },
    go(_delta: number) { throw Error('Native iframe traversal must not run') },
  }
  runInNewContext('(' + installNavigationFrame.toString() + ')({reviewer:"https://review.example",build:"a"})', {
    parent, window: {}, history, crypto, URL, DOMException, structuredClone,
    location: { get href() { return url.href }, get origin() { return url.origin }, get hash() { return url.hash } },
    document: { addEventListener() {} },
    addEventListener(type: string, listener: (event: object) => void) { listeners[type] = listener },
    dispatchEvent(event: { type: string; state: unknown }) { events.push(event) },
    PopStateEvent: class { constructor(public type: string, public state: unknown) { this.state = (state as { state: unknown }).state } },
    HashChangeEvent: class { constructor(public type: string) {} },
  })
  const command = (data: object, origin = 'https://review.example', source: object = parent) => listeners['message']!({ origin, source, data: { channel: 'preview-navigation', build: 'a', ...data } })
  command({ kind: 'connect', active: true, key: 'home' }, 'https://foreign.example')
  history.pushState({ secret: 'local-only' }, '', '/ignored')
  expect(messages).toHaveLength(1) // Only hello; no foreign connection.
  command({ kind: 'connect', active: true, key: 'home' })
  history.pushState({ secret: 'local-only' }, '', '/detail?q=x#section')
  expect(messages.at(-1)).toMatchObject({ kind: 'push', path: '/detail?q=x#section' })
  expect(JSON.stringify(messages)).not.toContain('local-only')
  const detailKey = messages.at(-1)!['key']
  history.replaceState({ secret: 'replacement' }, '', '/detail?q=y#section')
  expect(messages.at(-1)).toMatchObject({ kind: 'replace', key: detailKey })
  history.go(-1)
  expect(messages.at(-1)).toMatchObject({ kind: 'traverse', delta: -1 })
  const before = replacements
  command({ kind: 'navigate', key: 'detail', path: '//foreign.example/' })
  command({ kind: 'navigate', key: 'home', path: '/ignored' }, 'https://review.example', {})
  expect(replacements).toBe(before)
  command({ kind: 'navigate', key: 'home', path: '/ignored' })
  expect(url.pathname).toBe('/ignored')
  expect(state).toEqual({ secret: 'local-only' })
  expect(events.filter(event => event.type === 'popstate').at(-1)).toMatchObject({ state: { secret: 'local-only' } })
  command({ kind: 'active', active: false })
  const count = messages.length
  history.go(-1)
  expect(messages).toHaveLength(count)
})
