import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import * as values from './values'
import { retainedCells, encodeValues, decodeValues } from './checkpoint'

test('message boundary rejects cross-account state and stale page sessions before any write', async () => {
  let account = 'alice', writes = 0, clock = 0
  type Reply = { result?: { session: { account: string }; values: unknown[] }; error?: string; timing: { sessionMs: number; payloadWaitMs: number; operationMs: number } }
  const parent = { postMessage(message: unknown) { replies.push(message as Reply) } }
  const replies: Reply[] = []
  let receive: (event: { source: object; origin: string; data: object }) => Promise<void> = async () => {}
  const source = (await Bun.file(new URL('./runtime.js', import.meta.url)).text())
    .replace(/^import .*$/gm, '').replaceAll('export function ', 'function ')
    .replace('const authorizeSession = null', 'const authorizeSession = sessionCheck')
  runInNewContext(source + '\n cells.set("draft",[{id:"draft",kind:"state",schema:{root:0,nodes:[{kind:"primitive",name:"string"}]},read:()=>"private draft",write:onWrite}]); markMounted()', {
    ...values, retainedCells, encodeValues, decodeValues, crypto, performance: { now: () => clock }, URL, DOMException, structuredClone,
    parent, window: {}, sessionCheck: async () => { clock += 37; return { account, environment: 'test' } }, onWrite: () => writes++,
    history: { state: null, replaceState() {} },
    location: { pathname: '/', search: '', hash: '', origin: 'https://a.example', href: 'https://a.example/' },
    document: { querySelectorAll: () => [] },
    addEventListener(type: string, callback: typeof receive) { if (type === 'message') receive = callback },
  })
  const request = (operation: string, snapshot?: object, origin = '__PREVIEW_ORIGIN__') => receive({ source: parent, origin, data: { channel: 'preview-state', id: 1, operation, snapshot } })
  await request('capture', undefined, 'https://untrusted.example')
  expect(replies).toHaveLength(0)
  await request('capture')
  expect(replies.at(-1)!.timing).toEqual({ sessionMs: 37, payloadWaitMs: 0, operationMs: 0 })
  const captured = replies.at(-1)!.result!
  expect(captured.session.account).toBe('alice')
  expect(captured.values).toHaveLength(1)
  await request('restore', { ...captured, session: { account: 'bob', environment: 'test' } })
  expect(replies.at(-1)!.error).toBe('Build accounts or environments do not match')
  await request('prepare', { entries: [], session: { account: 'alice', environment: 'other' } })
  expect(replies.at(-1)!.error).toBe('Build accounts or environments do not match')
  account = 'bob'
  await request('capture')
  expect(replies.at(-1)!.error).toBe('Build account changed; reload before comparing')
  expect(replies.at(-1)!.result).toBeUndefined()
  expect(replies.at(-1)!.timing).toEqual({ sessionMs: 37, payloadWaitMs: 0, operationMs: 0 })
  expect(writes).toBe(0)
})

test('a deferred restore starts authentication immediately but cannot write until both authentication and data succeed', async () => {
  for (const failure of [null, 'account', 'capture'] as const) {
    let writes = 0, checks = 0, closed = 0
    let release!: () => void
    const authorized = new Promise<void>(resolve => { release = resolve })
    type Port = { onmessage: ((event: { data: object }) => void) | null; onmessageerror: (() => void) | null; close: () => void }
    const port: Port = { onmessage: null, onmessageerror: null, close: () => { closed++ } }
    let reply: { error?: string; result?: { rejected: string[] } } = {}
    const parent = { postMessage: (message: typeof reply) => { reply = message } }
    let receive!: (event: { source: object; origin: string; data: object; ports: Port[] }) => Promise<void>
    const source = (await Bun.file(new URL('./runtime.js', import.meta.url)).text())
      .replace(/^import .*$/gm, '').replaceAll('export function ', 'function ')
      .replace('const authorizeSession = null', 'const authorizeSession = sessionCheck')
    runInNewContext(source + '\n session={account:"alice",environment:"test"}; cells.set("draft",[{id:"draft",kind:"state",schema:{root:0,nodes:[{kind:"primitive",name:"string"}]},read:()=>draft,write:next=>{draft=next;onWrite()}}]);', {
      ...values, retainedCells, encodeValues, decodeValues, crypto, performance, URL, DOMException, structuredClone, setTimeout, clearTimeout,
      parent, window: {}, draft: 'local', onWrite: () => writes++, flushSync: (commit: () => void) => commit(),
      sessionCheck: async () => { checks++; await authorized; return { account: failure === 'account' ? 'bob' : 'alice', environment: 'test' } },
      history: { state: null, replaceState() {} },
      location: { pathname: '/', search: '', hash: '', origin: 'https://a.example', href: 'https://a.example/' },
      addEventListener(type: string, callback: typeof receive) { if (type === 'message') receive = callback },
    })
    const finished = receive({ source: parent, origin: '__PREVIEW_ORIGIN__', data: { channel: 'preview-state', id: 2, operation: 'restore' }, ports: [port] })
    expect(checks).toBe(1) // Authentication begins before the source has captured anything.
    const snapshot = { id: 'capture', base: null, session: { account: 'alice', environment: 'test' }, values: [{ id: 'draft', kind: 'state', value: 'incoming' }], scroll: [], history: { entries: [{ path: '/', state: null }], index: 0 } }
    port.onmessage!({ data: failure === 'capture' ? { error: 'Source capture failed' } : { snapshot } })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(writes).toBe(0) // A valid payload alone must never authorize a write.
    release()
    await finished
    expect(closed).toBe(1)
    switch (failure) {
      case null: expect(writes).toBe(1); expect(reply.result!.rejected).toEqual([]); break
      case 'account': expect(writes).toBe(0); expect(reply.error).toBe('Build account changed; reload before comparing'); break
      case 'capture': expect(writes).toBe(0); expect(reply.error).toBe('Source capture failed'); break
    }
  }
})

test('direct capture sends shared data only through the peer port and closes it on success or auth failure', async () => {
  for (const authorized of [true, false]) {
    const shared = { title: 'private job' }, data = { first: shared, selected: shared }
    const peers: { snapshot?: { values: { value: typeof data }[] }; error?: string }[] = []
    const replies: { result?: Record<string, unknown>; error?: string }[] = []
    let closed = 0
    const parent = { postMessage(message: typeof replies[number]) { replies.push(message) } }
    const port = { postMessage(message: typeof peers[number]) { peers.push(structuredClone(message)) }, close() { closed++ } }
    let receive!: (event: { source: object; origin: string; data: object; ports: typeof port[] }) => Promise<void>
    const source = (await Bun.file(new URL('./runtime.js', import.meta.url)).text())
      .replace(/^import .*$/gm, '').replaceAll('export function ', 'function ')
      .replace('const authorizeSession = null', 'const authorizeSession = sessionCheck')
    runInNewContext(source + '\n cells.set("jobs",[{id:"jobs",kind:"ref",schema:{root:0,nodes:[{kind:"data"}]},read:()=>data}]); markMounted()', {
      ...values, retainedCells, encodeValues, decodeValues, crypto, performance, URL, DOMException, structuredClone,
      parent, window: {}, data, sessionCheck: () => { if (!authorized) throw new Error('Signed out'); return { account: 'alice', environment: 'test' } },
      history: { state: null, replaceState() {} },
      location: { pathname: '/', search: '', hash: '', origin: 'https://a.example', href: 'https://a.example/' },
      document: { querySelectorAll: () => [] },
      addEventListener(type: string, callback: typeof receive) { if (type === 'message') receive = callback },
    })
    await receive({ source: parent, origin: '__PREVIEW_ORIGIN__', data: { channel: 'preview-state', id: 1, operation: 'capture' }, ports: [port] })
    expect(closed).toBe(1)
    expect(peers).toHaveLength(1)
    expect(replies).toHaveLength(1)
    if (authorized) {
      const received = peers[0]!.snapshot!.values[0]!.value
      expect(received).toEqual(data)
      expect(received.selected).toBe(received.first)
      expect(received.first).not.toBe(shared)
      expect(replies[0]!.result!['values']).toBeUndefined()
      expect(replies[0]!.result!['history']).toBeUndefined()
      expect(replies[0]!.result!['session']).toBeUndefined()
      expect(JSON.stringify(replies)).not.toContain('private job')
    } else {
      expect(peers[0]!.snapshot).toBeUndefined()
      expect(peers[0]!.error).toContain('Signed out')
      expect(replies[0]!.error).toContain('Signed out')
    }
  }
})
