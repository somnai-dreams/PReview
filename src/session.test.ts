import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import * as values from './values'
import { retainedCells, encodeValues, decodeValues } from './checkpoint'

test('message boundary rejects cross-account state and stale page sessions before any write', async () => {
  let account = 'alice', writes = 0, clock = 0
  type Reply = { result?: { session: { account: string }; values: unknown[] }; error?: string; timing: { sessionMs: number; operationMs: number } }
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
  expect(replies.at(-1)!.timing).toEqual({ sessionMs: 37, operationMs: 0 })
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
  expect(replies.at(-1)!.timing).toEqual({ sessionMs: 37, operationMs: 0 })
  expect(writes).toBe(0)
})
