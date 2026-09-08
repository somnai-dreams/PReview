import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepare } from './compiler'
import { accepts } from './values'

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
type Row = {title:string} & {position:[number,number]}
export function DataOwner(){const cache=useRef<Map<string,Row>>(new Map());return cache}
export function MetadataOwner(){const metadata=useRef<{counts:Partial<Record<'up'|'down',number>>;extra:Record<string,unknown>}>({counts:{},extra:{}});return metadata}
export function Handles(){const element=useRef<HTMLDivElement|null>(null);const callbacks=useRef<Array<()=>void>>([]);return {element,callbacks}}
type Result = {kind:'saved';title:string;pixels?:Uint8Array} | {kind:'active';resource:AbortController}
export function MixedData(){const results=useRef<Result[]>([]);return results}
`)
    const {cells,sources}=prepare(root)
    expect(cells.find(cell=>cell.id.endsWith('DraftOwner:draft'))?.policy).toBe('candidate')
    expect(cells.find(cell=>cell.id.endsWith('Measurement:width'))?.policy).toBe('effect-owned')
    const canvasCells=cells.filter(cell=>cell.id.includes(':CanvasOwner:'))
    expect(canvasCells.map(cell=>cell.policy)).toEqual(['canvas-owned','canvas-owned','canvas-owned'])
    expect(canvasCells.every(cell=>cell.schema.nodes[cell.schema.root]?.kind==='reject')).toBe(true)
    const output=sources.get(join(root,'src/owners.ts'))!
    expect(output).toContain('const __previewSchemas = ')
    expect(output).toContain('__previewSchemas[0]')
    const data = cells.find(cell => cell.id.endsWith('DataOwner:cache'))!
    expect(data.kind).toBe('ref')
    expect(data.policy).toBe('candidate')
    expect(accepts(data.schema, new Map([['one', { title: 'new', position: [1, 2] }]]))).toBe(true)
    expect(accepts(data.schema, new Map([['one', { title: 5, position: [1, 2] }]]))).toBe(false)
    expect(cells.filter(cell => cell.id.includes(':Handles:')).map(cell => cell.policy)).toEqual(['opaque-ref', 'opaque-ref'])
    expect(output).toContain('__previewRef(')
    const mixed = cells.find(cell => cell.id.endsWith('MixedData:results'))!
    expect(mixed.policy).toBe('candidate')
    expect(accepts(mixed.schema, [{ kind: 'saved', title: 'ordinary data' }])).toBe(true)
    expect(accepts(mixed.schema, [{ kind: 'saved', title: 'has resource', pixels: new Uint8Array(1) }])).toBe(false)
    expect(accepts(mixed.schema, [{ kind: 'active', resource: new AbortController() }])).toBe(false)
    expect(accepts(mixed.schema, [{ kind: 'saved', title: 1 }])).toBe(false)
    const metadata = cells.find(cell => cell.id.endsWith('MetadataOwner:metadata'))!
    expect(metadata.policy).toBe('candidate')
    expect(accepts(metadata.schema, { counts: { up: 2 }, extra: { nested: ['plain', 3] } })).toBe(true)
    expect(accepts(metadata.schema, { counts: { up: 'bad' }, extra: {} })).toBe(false)
    expect(accepts(metadata.schema, { counts: {}, extra: { callback: () => {} } })).toBe(false)
  } finally { await rm(root,{recursive:true,force:true}) }
})
