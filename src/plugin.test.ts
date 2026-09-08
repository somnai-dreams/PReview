import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewPlugin } from './plugin'

test('the observed runtime uses the target application renderer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-renderer-'))
  try {
    await mkdir(join(root, 'src'))
    await Bun.write(join(root, 'package.json'), '{}')
    await Bun.write(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }))
    for (const name of ['react', 'react-dom']) {
      await mkdir(join(root, 'node_modules', name), { recursive: true })
      await Bun.write(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
    }
    await Bun.write(join(root, 'node_modules/react/index.js'), 'export function useState(){}; export function useRef(){}; export function useLayoutEffect(){}')
    await Bun.write(join(root, 'node_modules/react-dom/index.js'), 'export function flushSync(callback){globalThis.__targetRenderer=true;callback()}')
    const entry = join(root, 'src/index.ts')
    await Bun.write(entry, "import { useObservedState } from 'preview-runtime'; console.log(useObservedState)")
    const { plugin } = await previewPlugin(root, 'http://localhost:4510')
    const build = await Bun.build({ entrypoints: [entry], target: 'browser', plugins: [plugin] })
    expect(build.success).toBe(true)
    expect(await build.outputs[0]!.text()).toContain('__targetRenderer')
  } finally { await rm(root, { recursive: true, force: true }) }
})
