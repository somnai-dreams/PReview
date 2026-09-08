import { createServer } from 'node:net'

export async function availablePort(port: number) {
  // Node and Bun may resolve localhost to different address families.
  for (const address of ['127.0.0.1', '::1']) {
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.once('error', () => reject(new Error('Port ' + port + ' is in use or unavailable; choose another --port')))
      server.listen(port, address, () => { server.close(error => error === undefined ? resolve() : reject(error)) })
    })
  }
}

export function localPort(raw: string | undefined): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Expected a port between 1024 and 65535')
  return port
}

export function localURL(raw: string): URL {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'localhost' || url.username !== '' || url.password !== '') {
    throw new Error('Expected an http://localhost:PORT or https://localhost:PORT URL')
  }
  localPort(url.port)
  return url
}

export function localOrigin(raw: string): string {
  const url = localURL(raw)
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error('Expected an origin without a path, query or fragment')
  return url.origin
}
