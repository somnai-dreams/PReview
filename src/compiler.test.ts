import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepare } from './compiler'

test('a setter exposed through shorthand remains a candidate despite mount resets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-compiler-'))
  try {
    await mkdir(join(root, 'src'))
    await Bun.write(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions:{strict:true,target:'ES2022'},include:['src']}))
    await Bun.write(join(root, 'src/owners.ts'), `
declare function useState<T>(initial:T):[T,(value:T)=>void]
declare function useEffect(effect:()=>void,deps:never[]):void
export function DraftOwner(){const [draft,setDraft]=useState('');useEffect(()=>setDraft(''),[]);return {draft,setDraft}}
export function Measurement(){const [width,setWidth]=useState(0);useEffect(()=>setWidth(1024),[]);return width}
declare function useRef<T>(initial:T):{current:T}
type Surface = HTMLCanvasElement
export function CanvasOwner(){const canvas=useRef<Surface|null>(null);const [hasStrokes,setHasStrokes]=useState(false);const [placement,setPlacement]=useState({x:0,y:0});return {canvas,hasStrokes,setHasStrokes,placement,setPlacement}}
`)
    const {cells,sources}=prepare(root)
    expect(cells.find(cell=>cell.id.endsWith('DraftOwner:draft'))?.policy).toBe('candidate')
    expect(cells.find(cell=>cell.id.endsWith('Measurement:width'))?.policy).toBe('effect-owned')
    const canvasCells=cells.filter(cell=>cell.id.includes(':CanvasOwner:'))
    expect(canvasCells.map(cell=>cell.policy)).toEqual(['canvas-owned','canvas-owned'])
    expect(canvasCells.every(cell=>cell.schema.nodes[cell.schema.root]?.kind==='reject')).toBe(true)
    const output=sources.get(join(root,'src/owners.ts'))!
    expect(output).toContain('const __previewSchemas = ')
    expect(output).toContain('__previewSchemas[0]')
  } finally { await rm(root,{recursive:true,force:true}) }
})
