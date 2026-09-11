import type { BunPlugin } from 'bun'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { prepare } from './compiler'
import { deploymentOrigin } from './origin'
import { instrumentWrites } from './write-compiler'

// The caller owns the app's entry points, CSS, public environment, assets and
// backend. This plugin changes only the source returned to the bundler.
export async function previewPlugin(checkout: string, reviewer: string, options: { sessionModule?: string; runtimeExtension?: string } = {}) {
  const root = resolve(checkout)
  const origin = deploymentOrigin(reviewer)
  const { cells, sources } = prepare(root)
  const fast = process.env['PREVIEW_INCREMENTAL'] === '1'
  const writeCoverage = { modules: 0, dependencies: 0, sites: 0, unsupported: 0, opaque: 0 }
  const appRequire = createRequire(resolve(root, 'package.json'))
  const runtime = (await Bun.file(new URL('./runtime.js', import.meta.url)).text())
    .replace("from 'react'", 'from ' + JSON.stringify(appRequire.resolve('react')))
    .replace("from 'react-dom'", 'from ' + JSON.stringify(appRequire.resolve('react-dom')))
    .replace("from './values'", 'from ' + JSON.stringify(resolve(import.meta.dir, 'values.ts')))
    .replace("from './react-state'", 'from ' + JSON.stringify(resolve(import.meta.dir, 'react-state.ts')))
    .replace(/from '\.\/transfer\/([^']+)'/g, (_, name: string) => 'from ' + JSON.stringify(resolve(import.meta.dir, 'transfer', name + '.ts')))
    .replace("'__PREVIEW_ORIGIN__'", JSON.stringify(origin))
    .replace('const authorizeSession = null', options.sessionModule === undefined ? 'const authorizeSession = null' : 'import { authorizeSession } from ' + JSON.stringify(resolve(options.sessionModule)))
    .replace('const createExtension = null', options.runtimeExtension === undefined ? 'const createExtension = null' : 'import { createExtension } from ' + JSON.stringify(resolve(options.runtimeExtension)))
  const reactCache = (await Bun.file(new URL('./react-cache.js', import.meta.url)).text())
    .replaceAll("from 'react'", 'from ' + JSON.stringify(appRequire.resolve('react')))
    .replace("from './react-state'", 'from ' + JSON.stringify(resolve(import.meta.dir, 'react-state.ts')))
  const plugin: BunPlugin = {
    name: 'preview-state',
    setup(build) {
      build.onResolve({ filter: /^preview-runtime$/ }, () => ({ path: 'runtime', namespace: 'preview' }))
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react-cache', namespace: 'preview' }))
      build.onLoad({ filter: /.*/, namespace: 'preview' }, ({ path }) => ({ contents: path === 'runtime' ? runtime : reactCache, loader: 'js', resolveDir: import.meta.dir }))
      build.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, async ({ path }) => {
        const observed = sources.get(path)
        // Include app dependencies. Exclude PReview's own graph machinery and
        // observer: instrumenting the tracker itself would recurse. Include values.ts
        // so restore writes invalidate the same watches as application writes.
        const internal = (path.startsWith(import.meta.dir + '/') && path !== resolve(import.meta.dir, 'values.ts')) || (options.runtimeExtension !== undefined && path.startsWith(dirname(resolve(options.runtimeExtension)) + '/'))
        if (!fast || internal) return observed === undefined ? undefined : { contents: observed, loader: path.endsWith('x') ? 'tsx' : 'ts' }
        const transformed = instrumentWrites(path, observed ?? await Bun.file(path).text())
        writeCoverage.opaque += transformed.opaque; writeCoverage.modules++; writeCoverage.sites += transformed.sites; writeCoverage.unsupported += transformed.unsupported
        if (path.includes('/node_modules/')) writeCoverage.dependencies++
        return { contents: transformed.code, loader: path.endsWith('x') ? 'tsx' : 'ts' }
      })
    },
  }
  return { plugin, cells, writeCoverage }
}
