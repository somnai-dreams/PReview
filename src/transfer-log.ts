// Shared browser/server boundary. Reconstruct the record so application values,
// cell paths, URLs and error text can never hitch a ride in diagnostic logs.
// Keep this function self-contained: the reviewer embeds it in its browser script.
export function parseTransferLog(raw: unknown) {
  function object(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid transfer log')
    return value as Record<string, unknown>
  }
  function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER, integer = false): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || integer && !Number.isInteger(value)) throw new Error('Invalid transfer metric')
    return value
  }
  function fields(value: unknown, names: string[], integer = false) {
    const input = object(value), result: Record<string, number> = {}
    for (const name of names) if (input[name] !== undefined) result[name] = number(input[name], integer ? Number.MAX_SAFE_INTEGER : 86400000, integer)
    return result
  }
  function index(value: unknown) {
    if (value === null) return null
    const input = object(value)
    if (typeof input['enabled'] !== 'boolean' || typeof input['coverage'] !== 'boolean') throw new Error('Invalid transfer index')
    return { ...fields(input, ['indexedObjects', 'indexedRoots', 'fieldChecks', 'shallowChecks', 'hits', 'misses', 'roots', 'pending'], true),
      ...fields(input, ['drainMs', 'indexMs']), enabled: input['enabled'], coverage: input['coverage'] }
  }
  const input = object(raw)
  const builds = input['builds']
  if (!Array.isArray(builds) || builds.length < 2 || builds.length > 4) throw new Error('Invalid transfer builds')
  const ids = builds.map((id: unknown) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw new Error('Invalid transfer build ID')
    return id
  })
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate transfer builds')
  const session = input['session'], engine = input['engine'], outcome = input['outcome']
  if (input['version'] !== 1 || typeof session !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(session)) throw new Error('Invalid transfer session')
  if (engine !== 'full' && engine !== 'incremental' || outcome !== 'restored' && outcome !== 'rejected' && outcome !== 'error') throw new Error('Invalid transfer outcome')
  const source = number(input['source'], ids.length - 1, true), destination = number(input['destination'], ids.length - 1, true)
  if (source === destination) throw new Error('Invalid transfer direction')
  function commands(value: unknown) {
    if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid transfer commands')
    return value.map((raw: unknown) => {
      const command = object(raw), operation = command['operation']
      if (operation !== 'capture' && operation !== 'checkpoint' && operation !== 'restore' && operation !== 'prepare') throw new Error('Invalid transfer operation')
      if (typeof command['failed'] !== 'boolean') throw new Error('Invalid transfer command outcome')
      return { build: number(command['build'], ids.length - 1, true), operation, failed: command['failed'],
        ...fields(command, ['roundTripMs', 'sessionMs', 'payloadWaitMs', 'operationMs', 'transportAndQueueMs']) }
    })
  }
  const timing = object(input['timing'])
  return { version: 1 as const, session, sequence: number(input['sequence'], Number.MAX_SAFE_INTEGER, true), builds: ids, source, destination, engine, outcome,
    milliseconds: number(input['milliseconds'], 86400000),
    counts: fields(input['counts'], ['restored', 'absent', 'rejected', 'secondPass', 'changed', 'retained', 'transferred', 'sourceSkipped', 'destinationSkipped', 'copiedObjects', 'patchedObjects', 'reusedObjects', 'heapBytes'], true),
    rejectionReasons: fields(input['rejectionReasons'] ?? {}, ['hook-kind-mismatch', 'incoming-value-invalid', 'live-ref-invalid', 'multiple-instances-after-commit'], true),
    rejectionPhases: fields(input['rejectionPhases'] ?? {}, ['validation', 'repair', 'verification'], true),
    sourceIndex: index(input['sourceIndex']), destinationIndex: index(input['destinationIndex']),
    timing: { ...fields(timing, ['routeWaitMs', 'presentationMs', 'captureMs', 'comparisonMs', 'decodeMs', 'validationMs', 'firstCommitMs', 'secondCommitMs', 'verificationMs', 'restoreMs', 'validationAndScrollMs', 'encodeMs', 'decodeAndValidateMs', 'captureIndexMs', 'repairCheckMs', 'repairIndexMs', 'repairCommitMs']),
      commands: commands(timing['commands']), routePreparation: commands(timing['routePreparation']) } }
}
