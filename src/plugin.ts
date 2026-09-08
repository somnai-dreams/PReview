import type { BunPlugin } from 'bun'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { prepare } from './compiler'
import { localOrigin } from './local'
import { instrumentWrites } from '../experiments/writes/compiler'

// The caller owns the app's entry points, CSS, public environment, assets and
// backend. This plugin changes only the source returned to the bundler.
export async function previewPlugin(checkout: string, reviewer: string) {
  const root = resolve(checkout)
  const origin = localOrigin(reviewer)
  const { cells, sources } = prepare(root)
  const fast = process.env['PREVIEW_INCREMENTAL'] === '1'
  const writes = process.env['PREVIEW_WRITE_PROBE'] === '1'
  if (fast && writes) throw new Error('Choose the incremental engine or the older shadow observer')
  const writeCoverage = { modules: 0, dependencies: 0, sites: 0, unsupported: 0, opaque: 0 }
  const appRequire = createRequire(resolve(root, 'package.json'))
  let runtime = (await Bun.file(new URL('./runtime.js', import.meta.url)).text())
    .replace("from 'react'", 'from ' + JSON.stringify(appRequire.resolve('react')))
    .replace("from 'react-dom'", 'from ' + JSON.stringify(appRequire.resolve('react-dom')))
    .replace("from './values'", 'from ' + JSON.stringify(resolve(import.meta.dir, 'values.ts')))
    .replace("from './checkpoint'", 'from ' + JSON.stringify(resolve(import.meta.dir, 'checkpoint.ts')))
    .replace("'__PREVIEW_ORIGIN__'", JSON.stringify(origin))
  // Opt-in shadow experiment. The normal capture/restore path remains the
  // authority; the observer reports whether its cheaper prediction missed data.
  if (process.env['PREVIEW_FIBER_PROBE'] === '1') {
    const replacements = [
      ['instances.push(cell)', 'instances.push(cell); globalThis.__previewFiberProbe.register(cell)'],
      ['const index = instances.indexOf(cell)', 'globalThis.__previewFiberProbe.remove(cell); const index = instances.indexOf(cell)'],
      ['const scroll = []', 'globalThis.__previewFiberProbe.audit(values.map(saved => ({...saved, owner: owners.get(saved.id)})), retained, new Set(previous.map(saved => saved.id)), checkpoint !== null); const scroll = []'],
    ]
    for (const [before, after] of replacements) {
      if (!runtime.includes(before!)) throw new Error('Fiber experiment runtime changed')
      runtime = runtime.replace(before!, after!)
    }
  }
  if (writes) {
    const replacements = [
      ['const index = instances.indexOf(cell)', 'globalThis.__previewWrites.remove(cell); const index = instances.indexOf(cell)'],
      ['const scroll = []', 'globalThis.__previewWrites.audit(candidates, values.map(saved => ({...saved, owner: owners.get(saved.id)})), retained, new Set(previous.map(saved => saved.id)), checkpoint !== null, comparisonMs); const scroll = []'],
      ['return { incremental: incremental?.stats(), restored, rejected, absent: absent.filter', 'if (rejected.length === 0) globalThis.__previewWrites.restored(snapshot.values.flatMap(saved => { const owner = cells.get(saved.id)?.[0]; return owner === undefined || !restored.includes(saved.id) ? [] : [{id:saved.id, owner, value:owner.read()}] }), new Set(changed)); return { incremental: incremental?.stats(), restored, rejected, absent: absent.filter'],
    ]
    for (const [before, after] of replacements) {
      if (!runtime.includes(before!)) throw new Error('Write experiment runtime changed')
      runtime = runtime.replace(before!, after!)
    }
  }
  const plugin: BunPlugin = {
    name: 'preview-state',
    setup(build) {
      build.onResolve({ filter: /^preview-runtime$/ }, () => ({ path: 'runtime', namespace: 'preview' }))
      build.onLoad({ filter: /.*/, namespace: 'preview' }, () => ({ contents: runtime, loader: 'js', resolveDir: import.meta.dir }))
      build.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, async ({ path }) => {
        const observed = sources.get(path)
        // Include app dependencies. Exclude PReview's own graph machinery and
        // observer: instrumenting the tracker itself would recurse. Include values.ts
        // so restore writes invalidate the same watches as application writes.
        const internal = (path.startsWith(import.meta.dir + '/') && path !== resolve(import.meta.dir, 'values.ts')) || (path.startsWith(resolve(import.meta.dir, '../experiments/writes') + '/') && !path.endsWith('/controls.tsx'))
        if (!(writes || fast) || internal) return observed === undefined ? undefined : { contents: observed, loader: path.endsWith('x') ? 'tsx' : 'ts' }
        const transformed = instrumentWrites(path, observed ?? await Bun.file(path).text(), fast)
        writeCoverage.opaque += transformed.opaque; writeCoverage.modules++; writeCoverage.sites += transformed.sites; writeCoverage.unsupported += transformed.unsupported
        if (path.includes('/node_modules/')) writeCoverage.dependencies++
        return { contents: transformed.code, loader: path.endsWith('x') ? 'tsx' : 'ts' }
      })
    },
  }
  return { plugin, cells, writeCoverage }
}
