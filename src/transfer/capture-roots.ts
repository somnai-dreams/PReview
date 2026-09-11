import type { Value } from '../values'
import type { liveProofs } from './live-proofs'
import type { Root } from './raw-transfer'

export type Capture = { values: Value[]; indices: number[]; skipped: number[]; validationMs: number }

// This preparation and the native send belong to one synchronous operation.
// Unsupported roots stay local. Retain only accepted roots before collecting
// identities, so a rejected root cannot export its successfully checked prefix.
export function captureRoots(graph: ReturnType<typeof liveProofs>, roots: Root[], fresh: boolean): Capture {
  const start = performance.now(), phase = graph.begin(new Map(), fresh)
  const values: Value[] = [], indices: number[] = [], skipped: number[] = []
  try {
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i]!
      if (phase.accepts(root.schema, root.value)) { values.push(root.value as Value); indices.push(i) }
      else skipped.push(i)
    }
    phase.commit()
    graph.keep(values)
    return { values, indices, skipped, validationMs: performance.now() - start }
  } finally { phase.close() }
}
