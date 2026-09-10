import { runInNewContext } from 'node:vm'
import { accepts, equal, type Schema, type Value } from './values'
import { runtimeState } from './transfer/runtime-state'
import { commitCells, type MountedCell } from './transfer/cell-commit'
import type { RestoredCell } from './transfer/transfer-session'

const source = (await Bun.file(new URL('./runtime.js', import.meta.url)).text()).replace(/^import .*$/gm, '').replaceAll('export function ', 'function ')
export const data: Schema = { root: 0, nodes: [{ kind: 'data' }] }
export const journal = { entries: [{ path: '/', state: null }], index: 0 }
export type Report = { retry: boolean; restored: string[]; rejected: string[]; changed: string[]; secondPass: string[]; absent: string[]; repairMode: string; scrollRestored: {id:string;method:string}[] }
export type Reply = { result?: Report; error?: string; timing?: { sessionMs: number; payloadWaitMs: number; operationMs: number } }
export function cell(id: string, kind: 'state' | 'ref', initial: unknown, schema = data) {
  let value = initial, writes = 0
  return { id, kind, schema, read: () => value, stale: () => false, write(next: Value) { value = next; writes++ }, reset(next: unknown) { value = next }, writes: () => writes }
}
let namespace = 0
export function harness(options: {
  observed?: boolean
  authorize?: () => Promise<{account:string;environment:string}>
  afterCommit?: (pass: number) => void
  document?: object
  historyState?: unknown
  onPopState?: (state: unknown) => void
} = {}) {
  const bridge = runtimeState(options.observed ?? true), replies: Reply[] = [], histories: unknown[] = []
  let commits = 0, sequence = 0
  type Event = { source: object; origin: string; data: object; ports: MessagePort[] }
  let receive!: (event: Event) => Promise<void>
  const parent = { postMessage(message: Reply) { replies.push(message) } }
  const runtime = runInNewContext(source.replace('const authorizeSession = null', options.authorize === undefined ? 'const authorizeSession = null' : 'const authorizeSession = sessionCheck') + `
    ;({ register(cell) { let list = cells.get(cell.id); if (list === undefined) { list = []; cells.set(cell.id,list) } list.push(cell); markMounted() },
       remove(id) { cells.delete(id) }, mountRef:useObservedRef,mountState:useObservedState,
       pending:()=>pending, history:()=>navigation, context:contextBoundary, push:history.pushState })`, {
    bridge, advanceRenderRevision() {}, accepts, equal, commitCells, crypto, performance, structuredClone, URL, DOMException, setTimeout, clearTimeout,
    parent, window: {}, sessionCheck: options.authorize,
    history: { state: options.historyState ?? null, replaceState(state: unknown, _unused: string, path: string) { histories.push({ state, path }) } },
    getComputedStyle: () => ({overflowY:'auto'}),
    PopStateEvent: class { state: unknown; constructor(_type:string, options:{state:unknown}){this.state=options.state} },
    dispatchEvent(event: {state:unknown}) { options.onPopState?.(event.state) },
    location: { pathname: '/', search: '', hash: '', origin: 'https://build.example', href: 'https://build.example/' },
    document: options.document ?? { querySelectorAll: () => [], getElementById: () => null },
    useRef: (current: unknown) => ({ current }), useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useLayoutEffect: (effect: () => void) => effect(),
    flushSync(write: () => void) { write(); options.afterCommit?.(++commits) },
    addEventListener(type: string, callback: typeof receive) { if (type === 'message') receive = callback },
  }) as { register(cell: MountedCell):void; remove(id:string):void; mountRef(id:string,schema:Schema,value:unknown):{current:Value}; mountState(id:string,schema:Schema,value:unknown):[Value,unknown]; pending():RestoredCell[]|null; history():typeof journal; context(value:unknown):unknown; push(state:unknown,unused:string,path:string):void }
  bridge.configure('runtime-tests', namespace++)
  async function request(operation:string, snapshot?:unknown, port?:MessagePort, origin='__PREVIEW_ORIGIN__') {
    const before = replies.length
    await receive({ source: parent, origin, data: { channel:'preview-state',id:++sequence,operation,snapshot }, ports: port === undefined ? [] : [port] })
    return replies.length === before ? undefined : replies.at(-1)
  }
  return { runtime, bridge, replies, histories, request, commits: () => commits }
}
export async function transfer(a:ReturnType<typeof harness>, b:ReturnType<typeof harness>) {
  const ports = new MessageChannel()
  const [target, source] = await Promise.all([b.request('restore',undefined,ports.port2), a.request('capture',undefined,ports.port1)])
  return { source: source!, target: target!, report: target!.result! }
}
