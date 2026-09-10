import { liveProofs } from './live-proofs'
import { nativeWriter } from './raw-transfer'
import { transferSession } from './transfer-session'

// The preload owns observation for the document lifetime. Object identities
// begin only when the reviewer assigns this frame its unique namespace.
export function runtimeState(complete = false) {
  const writer = nativeWriter()
  let current: { scope: string; site: number; graph: ReturnType<typeof liveProofs>; session: ReturnType<typeof transferSession> } | null = null
  let mode: 'full' | 'incremental' = complete ? 'incremental' : 'full'
  const observed = () => complete && mode === 'incremental'
  function configure(scope: string, site: number) {
    if (current !== null) {
      if (current.scope !== scope || current.site !== site) throw Error('Comparison changed; reload this build')
      return
    }
    const graph = liveProofs(site), session = transferSession(graph, scope)
    current = { scope, site, graph, session }
  }
  function connection() {
    if (current === null) throw Error('Build is not connected to a reviewer')
    return { ...current, writer }
  }
  return {
    configure, connection, observed,
    version: (value: unknown) => current?.graph.version(value),
    touch<T>(value: T): T { return current === null ? value : current.graph.touch(value) },
    assignment<T>(value: object, key: string, next: T): T { return current === null ? next : current.graph.assignment(value, key, next) },
    unobserved() { complete = false },
    engine(next: 'full' | 'incremental') {
      if (current !== null && current.session.status().phase !== 'idle') throw Error('Transfer already in progress')
      mode = next
    },
    stats() {
      const stats = current?.graph.stats()
      return { indexedObjects: stats?.objects ?? 0, pending: stats?.dirty ?? 0, fieldChecks: stats?.reads ?? 0, hits: stats?.hits ?? 0, enabled: observed(), coverage: complete }
    },
  }
}
