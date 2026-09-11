import { expect, test } from 'bun:test'
import { parseTransferLog } from './transfer-log'
import { reviewerResponse } from './host'

const report = {
  version: 1 as const, session: '10000000-0000-4000-8000-000000000001', sequence: 2, builds: ['build-a', 'build-b'], source: 1, destination: 0,
  engine: 'incremental', outcome: 'restored', milliseconds: 1200,
  rejectionReasons: { 'incoming-value-invalid': 1 }, rejectionPhases: { validation: 1 },
  counts: { restored: 12, retained: 9, transferred: 3 }, sourceIndex: { enabled: true, coverage: true, indexedObjects: 10000 }, destinationIndex: null,
  timing: { captureMs: 300, restoreMs: 800, commands: [{ build: 1, operation: 'capture', failed: false, roundTripMs: 350 }], routePreparation: [] },
}

test('logging preserves phase timings but cannot upload state or diagnostic strings', () => {
  const result = parseTransferLog({ ...report, rejectionReasons: { ...report.rejectionReasons, 'private-cell-name': 1 }, snapshot: { draft: 'private' }, error: 'private', recent: ['private'],
    counts: { ...report.counts, values: ['private'] }, sourceIndex: { ...report.sourceIndex, path: 'private' },
    timing: { ...report.timing, route: 'private', commands: [{ ...report.timing.commands[0], error: 'private', snapshot: 'private' }] } })
  expect(result).toEqual(report)
  expect(JSON.stringify(result)).not.toContain('private')
  for (const invalid of [
    { ...report, milliseconds: NaN }, { ...report, source: 3 }, { ...report, outcome: 'private' },
    { ...report, counts: { transferred: -1 } }, { ...report, builds: ['https://example.com/private', 'b'] },
    { ...report, timing: { ...report.timing, commands: Array(9).fill(report.timing.commands[0]) } },
  ]) expect(() => parseTransferLog(invalid)).toThrow()
})

test('logging is opt-in and cannot redirect diagnostic uploads to another origin', () => {
  const options = { origin: 'https://review.example', builds: [{ url: 'https://a.example', label: 'A' }, { url: 'https://b.example', label: 'B' }] }
  expect(reviewerResponse(options)(new Request(options.origin)).headers.get('content-security-policy')).not.toContain('connect-src')
  const logging = { endpoint: '/api/transfers', buildIds: ['a', 'b'] }
  expect(reviewerResponse({ ...options, transferLog: logging })(new Request(options.origin)).headers.get('content-security-policy')).toContain("connect-src 'self'")
  for (const endpoint of ['https://elsewhere.example/log', '//elsewhere.example/log', '/log?state=private']) {
    expect(() => reviewerResponse({ ...options, transferLog: { ...logging, endpoint } })).toThrow()
  }
})
