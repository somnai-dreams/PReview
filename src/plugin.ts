import type { BunPlugin } from 'bun'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { prepare } from './compiler'
import { localOrigin } from './local'

// The caller owns the app's entry points, CSS, public environment, assets and
// backend. This plugin changes only the source returned to the bundler.
export async function previewPlugin(checkout: string, reviewer: string) {
  const root = resolve(checkout)
  const origin = localOrigin(reviewer)
  const { cells, sources } = prepare(root)
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
  const plugin: BunPlugin = {
    name: 'preview-state',
    setup(build) {
      build.onResolve({ filter: /^preview-runtime$/ }, () => ({ path: 'runtime', namespace: 'preview' }))
      build.onLoad({ filter: /.*/, namespace: 'preview' }, () => ({ contents: runtime, loader: 'js', resolveDir: import.meta.dir }))
      build.onLoad({ filter: /\.[jt]sx?$/ }, ({ path }) => {
        const contents = sources.get(path)
        return contents === undefined ? undefined : { contents, loader: path.endsWith('x') ? 'tsx' : 'ts' }
      })
    },
  }
  return { plugin, cells }
}
