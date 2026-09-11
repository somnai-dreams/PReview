import { expect, test } from 'bun:test'
import { buildURL, deploymentOrigin } from './origin'
import { reviewerResponse } from './host'

test('deployment configuration permits exact HTTPS origins and localhost development', () => {
  expect(deploymentOrigin('https://review.example:443/')).toBe('https://review.example')
  expect(buildURL('https://a.example/explore?q=x').pathname).toBe('/explore')
  expect(deploymentOrigin('http://localhost:4510')).toBe('http://localhost:4510')
  for (const raw of ['http://remote.example', 'https://user:password@remote.example', 'data:text/html,x', 'javascript:alert(1)']) expect(() => buildURL(raw)).toThrow()
  for (const raw of ['https://review.example/path', 'https://review.example/?q=x', 'https://review.example/#x']) expect(() => deploymentOrigin(raw)).toThrow()
})

test('an embedded reviewer uses fixed configuration behind TLS termination', async () => {
  const respond = reviewerResponse({ origin: 'https://review.example', builds: [{ url: 'https://a.example', label: '</script> A' }, { url: 'https://b.example', label: 'B' }] })
  const response = respond(new Request('http://review.example/'))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-security-policy')).toContain('frame-src https://a.example https://b.example')
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.text()).not.toContain('</script> A')
  expect(respond(new Request('https://untrusted.example/', { headers: { 'x-forwarded-host': 'review.example' } })).status).toBe(403)
  expect(() => reviewerResponse({ origin: 'https://review.example', builds: [{ url: 'http://localhost:4511', label: 'A' }, { url: 'https://b.example', label: 'B' }] })).toThrow()
})
