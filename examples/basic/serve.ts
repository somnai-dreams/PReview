import { resolve } from 'node:path'
import { previewPlugin } from '../../src/plugin'
import { startReviewer } from '../../src/host'

const checkout = import.meta.dir
const reviewerOrigin = 'http://localhost:4510'
const { plugin, cells } = await previewPlugin(checkout, reviewerOrigin)
console.log('Discovered', cells.length, 'state cells')

for (const [variant, port] of [['A', 4511], ['B', 4512]] as const) {
  const result = await Bun.build({
    entrypoints: [resolve(checkout, 'src/App.tsx')],
    tsconfig: resolve(checkout, 'tsconfig.json'),
    target: 'browser',
    define: { BUILD_VARIANT: JSON.stringify(variant), 'process.env.NODE_ENV': '"development"' },
    plugins: [plugin],
  })
  if (!result.success) throw new AggregateError(result.logs, 'Example build failed')
  const entry = result.outputs.find(output => output.kind === 'entry-point')
  if (entry === undefined) throw new Error('Missing example entry point')
  const origin = 'http://localhost:' + port
  Bun.serve({
    hostname: 'localhost', port,
    fetch(request) {
      const url = new URL(request.url)
      if (url.origin !== origin) return new Response('Unexpected host', { status: 403 })
      if (url.pathname === '/app.js') return new Response(entry)
      return new Response('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PReview example</title></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>', { headers: { 'content-type': 'text/html' } })
    },
  })
}

startReviewer({ port: 4510, builds: ['http://localhost:4511', 'http://localhost:4512'] })
