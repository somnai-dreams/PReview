import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewPlugin } from './plugin'
import { runInNewContext } from 'node:vm'

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

test('renderer-first CommonJS entry can prepare a route in a minified production bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-renderer-order-'))
  try {
    await mkdir(join(root, 'src'))
    await Bun.write(join(root, 'package.json'), '{}')
    await Bun.write(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }))
    for (const name of ['react', 'react-dom']) {
      await mkdir(join(root, 'node_modules', name), { recursive: true })
      await Bun.write(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
    }
    await Bun.write(join(root, 'node_modules/react/index.js'), `exports.useState = initial => [typeof initial === 'function' ? initial() : initial, () => {}]; exports.useRef = current => ({current}); exports.useLayoutEffect = effect => effect()`)
    await Bun.write(join(root, 'node_modules/react-dom/index.js'), `require('react'); module.exports = {flushSync(callback) { globalThis.flushed = true; callback() }}`)
    await Bun.write(join(root, 'src/app.ts'), `import { useObservedState } from 'preview-runtime'; useObservedState('route', {root:0,nodes:[{kind:'data'}]}, 'home')`)
    const entry = join(root, 'src/index.ts')
    await Bun.write(entry, `import 'react-dom'; import './app'`)
    const { plugin } = await previewPlugin(root, 'https://review.example')
    const build = await Bun.build({ entrypoints: [entry], target: 'browser', plugins: [plugin], minify: true, define: { 'process.env.NODE_ENV': '"production"' } })
    expect(build.success).toBe(true)
    type Event = {source: object; origin: string; data: object}
    let receive!: (event: Event) => Promise<void>
    const replies: {result?: {navigated: boolean}; error?: string}[] = []
    const parent = {postMessage(reply: typeof replies[number]) { replies.push(reply) }}
    const context = {
      parent, window: {}, performance, structuredClone, URL, DOMException,
      flushed: false, history: { state: 'home', replaceState() {} },
      location: {pathname:'/',search:'',hash:'',origin:'https://build.example',href:'https://build.example/'},
      addEventListener(type: string, listener: typeof receive) { if (type === 'message') receive = listener },
      dispatchEvent() {}, PopStateEvent: class {},
    }
    runInNewContext(await build.outputs[0]!.text(), context)
    await receive({source: parent, origin:'https://review.example',data:{channel:'preview-state',id:1,operation:'prepare',snapshot:{session:null,entries:[{path:'/detail',state:'detail'}],index:0}}})
    expect(replies[0]?.error).toBeUndefined()
    expect(replies[0]?.result).toEqual({navigated:true})
    expect(context.flushed).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
