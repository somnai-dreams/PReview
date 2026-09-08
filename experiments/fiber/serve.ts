import { resolve } from 'node:path'
import { previewPlugin } from '../../src/plugin'
import { startReviewer } from '../../src/host'

// Dedicated experimental ports; this does not replace the ordinary demo.
const port = 4790
process.env['PREVIEW_FIBER_PROBE'] = '1'
const { plugin } = await previewPlugin(import.meta.dir, 'http://localhost:' + port)
const results = await Promise.all([
  Bun.build({ entrypoints: [resolve(import.meta.dir, 'observer.ts')], target: 'browser', format: 'iife' }),
  ...['A', 'B'].map(variant => Bun.build({ entrypoints: [resolve(import.meta.dir, 'src/App.tsx')], target: 'browser', plugins: [plugin], define: { BUILD_VARIANT: JSON.stringify(variant), 'process.env.NODE_ENV': '"development"' } })),
])
for (const result of results) if (!result.success) throw new AggregateError(result.logs, 'Experiment build failed')
const html = '<!doctype html><html><head><title>Fiber experiment</title></head><body><script src="/observer.js"></script><div id="root"></div><pre id="measurements" style="max-width:800px;margin:auto"></pre><script type="module" src="/app.js"></script></body></html>'
for (const childPort of [port + 1, port + 2]) {
  Bun.serve({ hostname: 'localhost', port: childPort, fetch(request) {
    const url = new URL(request.url)
    if (url.origin !== 'http://localhost:' + childPort) return new Response('Unexpected host', { status: 403 })
    switch (url.pathname) {
      case '/observer.js': return new Response(results[0]!.outputs[0])
      case '/app.js': return new Response(results[childPort - port]!.outputs[0])
      default: return new Response(html, { headers: { 'content-type': 'text/html' } })
    }
  } })
}
startReviewer({ port, builds: [{ url: 'http://localhost:4791', label: 'Probe A' }, { url: 'http://localhost:4792', label: 'Probe B' }] })
