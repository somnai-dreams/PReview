// Origins are deployment configuration, never inferred from forwarded headers
// or accepted from an incoming request. Remote builds require HTTPS.
export function buildURL(raw: string): URL {
  const url = new URL(raw)
  if (url.username !== '' || url.password !== '' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
    throw new Error('Expected an HTTPS URL, or HTTP on localhost, without credentials')
  }
  return url
}

export function deploymentOrigin(raw: string): string {
  const url = buildURL(raw)
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error('Expected an origin without a path, query or fragment')
  return url.origin
}
