import { resolve } from 'node:path'
import { previewPlugin } from '../../src/plugin'
import { startReviewer } from '../../src/host'
import { localPort } from '../../src/local'

const checkout = import.meta.dir
const hostPort = localPort(process.env['PORT'] ?? '4510')
const reviewerOrigin = 'http://localhost:' + hostPort
const { plugin, cells } = await previewPlugin(checkout, reviewerOrigin)
console.log('Discovered', cells.length, 'state cells')

for (const [variant, port] of [['A', localPort(String(hostPort + 1))], ['B', localPort(String(hostPort + 2))]] as const) {
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

startReviewer({ port: hostPort, builds: ['http://localhost:' + (hostPort + 1), 'http://localhost:' + (hostPort + 2)] })
