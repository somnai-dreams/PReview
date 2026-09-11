import { comparison, type Value } from '../values'
import type { liveProofs } from './live-proofs'
import { container } from './validate'
import { initialPacket, receiveInitial, nativeWriter, type Destination } from './raw-transfer'

// Incomplete observation cannot certify unchanged subtrees. Keep one ordinary
// native clone for this restore, compare all supported values, and discard it
// when the synchronous application commit finishes. No normalized field records
// or persistent second graph are needed for this fallback.
export function snapshotRepair(graph: ReturnType<typeof liveProofs>, roots: Destination[], writer: ReturnType<typeof nativeWriter>) {
  let snapshot = structuredClone(initialPacket(graph, roots.map(root => root.value as Value)))
  let closed = false
  function changed() {
    if (closed) throw Error('Snapshot repair is closed')
    const check = comparison(), values: object[] = []
    for (let i = 0; i < roots.length; i++) {
      const value = roots[i]!.value
      if (!check.matches(snapshot.values[i], value) && container(value)) values.push(value)
    }
    return values
  }
  return {
    changed,
    objects: () => snapshot.objects.length,
    repair() {
      if (changed().length === 0) return { ok: true as const, objects: 0 }
      const result = receiveInitial(graph, snapshot, roots, writer, true)
      if (!result.ok) return { ok: false as const, reason: result.reason, objects: 0 }
      for (let i = 0; i < roots.length; i++) roots[i]!.value = result.values[i]
      return { ok: true as const, objects: result.objects }
    },
    close() {
      if (closed) throw Error('Snapshot repair is closed')
      snapshot = { kind: 'initial', values: [], objects: [], ids: new Float64Array() }
      closed = true
    },
  }
}
