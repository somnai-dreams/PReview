import type { Schema, Value } from '../values'
import type { liveProofs } from './live-proofs'
import { container } from './validate'
import { nativeWriter } from './raw-transfer'
import { repairJournal } from './repair-journal'
import { snapshotRepair } from './snapshot-repair'
import type { RestoredCell } from './transfer-session'

export type MountedCell = { id: string; kind: 'ref' | 'state'; schema: Schema; read(): unknown; stale(): boolean; write(value: Value): void }
export type Application = {
  cells(): MountedCell[]
  commit(write: () => void): void
  pending(values: RestoredCell[] | null): void
  observed(): boolean
  afterFirstCommit?(): void
}
type Issue = { id: string; reason: 'ambiguous' | 'hook-kind' | 'incoming-type' | 'live-ref' }

export function commitCells(graph: ReturnType<typeof liveProofs>, saved: RestoredCell[], app: Application, writer: ReturnType<typeof nativeWriter>) {
  const restored: string[] = [], absent: string[] = [], changed: string[] = [], secondPass: string[] = [], issues: Issue[] = []
  const report = () => ({ restored, absent, changed, secondPass, issues })
  const mode = app.observed() ? 'observed' : 'snapshot'
  const journal = mode === 'observed' ? repairJournal(graph, saved, writer) : snapshotRepair(graph, saved, writer)
  const owners = new Map<string, MountedCell>()
  function plan(repair: boolean, affected: Set<object>) {
    const cells = new Map<string, MountedCell | null>()
    for (const cell of app.cells()) cells.set(cell.id, cells.has(cell.id) ? null : cell)
    const pending: { cell: MountedCell; saved: RestoredCell }[] = []
    const phase = graph.begin(new Map(), mode === 'snapshot')
    try {
      for (const value of saved) {
        const cell = cells.get(value.id)
        if (cell === undefined) continue
        if (cell === null) { issues.push({ id: value.id, reason: 'ambiguous' }); continue }
        if (cell.kind !== value.kind) { issues.push({ id: value.id, reason: 'hook-kind' }); continue }
        if (repair && owners.get(cell.id) !== cell) {
          if (!phase.accepts(cell.schema, value.value)) { issues.push({ id: value.id, reason: 'incoming-type' }); continue }
          if (cell.kind === 'ref' && !phase.accepts(cell.schema, cell.read())) { issues.push({ id: value.id, reason: 'live-ref' }); continue }
        }
        if (repair ? !Object.is(cell.read(), value.value) || container(value.value) && affected.has(value.value) || cell.stale() : value.changed || cell.stale()) pending.push({ cell, saved: value })
        owners.set(cell.id, cell)
        if (!restored.includes(cell.id)) restored.push(cell.id)
      }
      phase.commit()
    } finally { phase.close() }
    return pending
  }
  function apply(entries: ReturnType<typeof plan>) {
    if (entries.length === 0) return
    app.commit(() => {
      for (const kind of ['ref', 'state']) for (const item of entries) if (item.cell.kind === kind) item.cell.write(item.saved.value)
    })
  }
  try {
    app.pending(saved)
    const first = plan(false, new Set())
    if (issues.length > 0) return { ok: false, result: report() }
    apply(first)
    app.afterFirstCommit?.()
    if (mode === 'observed' && !app.observed()) return { ok: false, retry: 'full' as const, result: { ...report(), reason: 'observation-lost' } }
    // Save affected roots before repairing the bodies: they still need a React
    // refresh even though restoring the data itself makes their values equal.
    const affected = graph.ancestors(journal.changed())
    const repair = journal.repair()
    if (!repair.ok) return { ok: false, result: { ...report(), reason: repair.reason } }
    const second = plan(true, affected)
    if (issues.length === 0) {
      for (const item of second) secondPass.push(item.cell.id)
      apply(second)
    }
    if (mode === 'observed' && !app.observed()) return { ok: false, retry: 'full' as const, result: { ...report(), reason: 'observation-lost' } }
    const unsettled = graph.ancestors(journal.changed()), current = app.cells()
    const verified = graph.begin(new Map(), mode === 'snapshot')
    try { for (const value of saved) {
      const matches = current.filter(cell => cell.id === value.id)
      if (matches.length === 0) { absent.push(value.id); continue }
      if (matches.length !== 1) { if (!issues.some(issue => issue.id === value.id)) issues.push({ id: value.id, reason: 'ambiguous' }); continue }
      const cell = matches[0]!
      if (cell.kind !== value.kind) { if (!issues.some(issue => issue.id === value.id)) issues.push({ id: value.id, reason: 'hook-kind' }); continue }
      if (owners.get(cell.id) !== cell && !verified.accepts(cell.schema, value.value)) { issues.push({ id: value.id, reason: 'incoming-type' }); continue }
      if (!Object.is(cell.read(), value.value) || container(value.value) && unsettled.has(value.value)) changed.push(value.id)
    } verified.commit() } finally { verified.close() }
    return { ok: issues.length === 0, result: { ...report(), repairMode: mode, journalObjects: mode === 'observed' ? journal.objects() : 0, snapshotObjects: mode === 'snapshot' ? journal.objects() : 0 } }
  } finally { try { app.pending(null) } finally { journal.close() } }
}
