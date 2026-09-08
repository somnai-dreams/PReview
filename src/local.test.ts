import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { availablePort } from './local'

test('preflight detects occupied ports on either localhost address family', async () => {
  for (const address of ['127.0.0.1', '::1']) {
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve) })
    try {
      const info = server.address()
      if (info === null || typeof info === 'string') throw new Error('Missing TCP listener')
      await expect(availablePort(info.port)).rejects.toThrow('in use or unavailable')
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))) }
  }
})
