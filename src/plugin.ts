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
  const runtime = (await Bun.file(new URL('./runtime.js', import.meta.url)).text())
    .replace("from 'react'", 'from ' + JSON.stringify(appRequire.resolve('react')))
    .replace("from 'react-dom'", 'from ' + JSON.stringify(appRequire.resolve('react-dom')))
    .replace("from './values'", 'from ' + JSON.stringify(resolve(import.meta.dir, 'values.ts')))
    .replace("'__PREVIEW_ORIGIN__'", JSON.stringify(origin))
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
