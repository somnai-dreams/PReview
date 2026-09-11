import { expect, test } from 'bun:test'
import { harness } from './runtime-harness.test'

test('extension operations retain parent-origin and fresh session authorization gates', async () => {
  let authorized = 0, operations = 0
  const instance = harness({
    authorize: async () => { authorized++; if (authorized === 2) throw Error('session expired'); return {account:'synthetic',environment:'test'} },
    extension: () => ({ supports: (operation: string) => operation === 'diagnostic', transferring: () => false, async run() { operations++; return {count:1} } }),
  })
  expect(await instance.request('diagnostic', undefined, undefined, 'https://foreign.example')).toBeUndefined()
  expect(authorized).toBe(0)
  expect(await instance.request('diagnostic')).toMatchObject({result:{count:1}})
  expect((await instance.request('diagnostic'))?.error).toContain('session expired')
  expect(operations).toBe(1)
})
