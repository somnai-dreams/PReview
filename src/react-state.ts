import { runtimeState } from './transfer/runtime-state'

// React's cache adapter and the bridge share document state without importing
// each other. ReactDOM may require the adapter before its own exports exist.
const target = globalThis as typeof globalThis & { __previewTransfer?: ReturnType<typeof runtimeState> }
export const bridge = target.__previewTransfer ?? runtimeState()
let revision = 0
export function advanceRenderRevision() { revision++ }
export function renderRevision() { return revision }
export function valueVersion(value: unknown) { return bridge.version(value) }
