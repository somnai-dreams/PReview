import { resolve } from 'node:path'
import { previewPlugin } from '../../src/plugin'
import { startReviewer } from '../../src/host'
import { localPort } from '../../src/local'
const port = localPort(process.env['PORT'] ?? '4770')
process.env['PREVIEW_INCREMENTAL'] ??= '1'
const fast = process.env['PREVIEW_INCREMENTAL'] === '1'
const { plugin, writeCoverage } = await previewPlugin(import.meta.dir, 'http://localhost:' + port)
const builds = await Promise.all(['A', 'B'].map(variant => Bun.build({ entrypoints: [resolve(import.meta.dir, 'src/App.tsx')], target: 'browser', plugins: [plugin], define: { BUILD_VARIANT: JSON.stringify(variant), 'process.env.NODE_ENV': '"development"' } })))
for (const result of builds) if (!result.success) throw new AggregateError(result.logs, 'App build failed')
const preload = fast ? await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../src/incremental-preload.ts')], target: 'browser', format: 'iife', minify: true, define: { __PREVIEW_COMPLETE__: JSON.stringify(writeCoverage.unsupported === 0) } }) : null
if (preload !== null && !preload.success) throw new AggregateError(preload.logs, 'Preload build failed')
console.log('Incremental coverage', JSON.stringify(writeCoverage))
console.log('Preload bytes', preload?.outputs[0]?.size ?? 0)
for (const [index, build] of builds.entries()) Bun.serve({ hostname: 'localhost', port: port + index + 1, fetch(request) {
  const url = new URL(request.url)
  if (url.origin !== 'http://localhost:' + (port + index + 1)) return new Response('Unexpected host', { status:403 })
  switch (url.pathname) {
    case '/preload.js': return new Response(preload?.outputs[0] ?? '')
    case '/app.js': return new Response(build.outputs[0])
    default: return new Response('<!doctype html><title>Incremental comparison</title>' + (fast ? '<script src="/preload.js"></script>' : '') + '<div id="root"></div><script type="module" src="/app.js"></script>', { headers:{'content-type':'text/html'} })
  }
} })
startReviewer({ port, builds: [{ url:'http://localhost:' + (port + 1), label:'Build A' }, { url:'http://localhost:' + (port + 2), label:'Build B' }] })
