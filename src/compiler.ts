import ts from 'typescript'
import { relative, resolve } from 'node:path'
import type { Shape, Schema } from './values'
export type Cell = { id: string; kind: 'state' | 'ref'; line: number; type: string; policy: 'candidate' | 'effect-owned' | 'canvas-owned' | 'opaque-ref'; schema: Schema }

export function prepare(checkout: string) {
  const configPath = resolve(checkout, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, checkout)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const cells: Cell[] = []
  const sources = new Map<string, string>()

  function schemaFor(root: ts.Type, location: ts.Node): Schema {
    const nodes: Shape[] = []
    const seen = new Map<ts.Type, number>()
    function visit(type: ts.Type): number {
      const previous = seen.get(type)
      if (previous !== undefined) return previous
      const id = nodes.length
      seen.set(type, id)
      nodes.push({ kind: 'reject', reason: 'unfinished' })
      function finish(shape: Shape) { nodes[id] = shape; return id }
      if (id > 1000) return finish({ kind: 'reject', reason: 'schema size' })
      if (type.flags & ts.TypeFlags.Unknown) return finish({ kind: 'data' })
      if (type.flags & ts.TypeFlags.StringLiteral) return finish({ kind: 'literal', value: (type as ts.StringLiteralType).value })
      if (type.flags & ts.TypeFlags.NumberLiteral) return finish({ kind: 'literal', value: (type as ts.NumberLiteralType).value })
      if (type.flags & ts.TypeFlags.BooleanLiteral) return finish({ kind: 'literal', value: checker.typeToString(type) === 'true' })
      if (type.flags & ts.TypeFlags.Null) return finish({ kind: 'literal', value: null })
      for (const [flag, name] of [[ts.TypeFlags.String, 'string'], [ts.TypeFlags.Number, 'number'], [ts.TypeFlags.Boolean, 'boolean'], [ts.TypeFlags.Undefined, 'undefined']] as const) {
        if (type.flags & flag) return finish({ kind: 'primitive', name })
      }
      if (type.isUnion()) return finish({ kind: 'union', members: type.types.map(visit) })
      if (checker.isTupleType(type)) {
        const tuple = type as ts.TupleTypeReference
        const flags = tuple.target.elementFlags
        if (flags.some(flag => flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic))) return finish({ kind: 'reject', reason: 'variable tuple' })
        return finish({ kind: 'tuple', items: checker.getTypeArguments(tuple).map(visit), required: flags.filter(flag => flag & ts.ElementFlags.Required).length })
      }
      if (checker.isArrayType(type)) {
        const item = checker.getTypeArguments(type as ts.TypeReference)[0]
        return finish(item === undefined ? { kind: 'reject', reason: 'array element' } : { kind: 'array', item: visit(item) })
      }
      const symbol = type.getSymbol()
      if (symbol?.name === 'Map' || symbol?.name === 'ReadonlyMap') {
        const [key, value] = checker.getTypeArguments(type as ts.TypeReference)
        function primitiveKey(type: ts.Type): boolean {
          if (type.isUnion()) return type.types.every(primitiveKey)
          return (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0
        }
        if (key !== undefined && !primitiveKey(key)) return finish({ kind: 'reject', reason: 'Map keys must be primitive values' })
        return finish(key === undefined || value === undefined ? { kind: 'reject', reason: 'map arguments' } : { kind: 'map', key: visit(key), value: visit(value) })
      }
      if (symbol?.name === 'Set' || symbol?.name === 'ReadonlySet') {
        const item = checker.getTypeArguments(type as ts.TypeReference)[0]
        return finish(item === undefined ? { kind: 'reject', reason: 'set element' } : { kind: 'set', item: visit(item) })
      }
      const objectShape = (type.flags & ts.TypeFlags.Object) !== 0 || type.isIntersection() && type.types.every(member => (member.flags & ts.TypeFlags.Object) !== 0)
      if (!objectShape || type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0 || symbol?.declarations?.some(ts.isClassDeclaration)) {
        return finish({ kind: 'reject', reason: checker.typeToString(type) })
      }
      const properties = type.getProperties()
      if (properties.some(property => property.declarations?.some(declaration => ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)))) {
        return finish({ kind: 'reject', reason: 'object with methods' })
      }
      const stringIndex = type.getStringIndexType()
      if (properties.length === 0 && stringIndex === undefined) return finish({ kind: 'reject', reason: 'opaque object' })
      const fields: { name: string; optional: boolean; shape: number }[] = []
      for (const property of properties) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0]
        fields.push({ name: property.name, optional: (property.flags & ts.SymbolFlags.Optional) !== 0, shape: visit(checker.getTypeOfSymbolAtLocation(property, declaration ?? location)) })
      }
      return finish({ kind: 'object', fields, index: stringIndex === undefined ? null : visit(stringIndex) })
    }
    return { root: visit(root), nodes }
  }

  for (const source of program.getSourceFiles()) {
    const path = relative(checkout, source.fileName)
    if (!path.startsWith('src/') || source.isDeclarationFile || /(?:test|spec)\.[jt]sx?$/.test(path)) continue
    // Auth is deliberately outside this state experiment, including synthetic auth.
    if (/auth|compliance|tracing|analytics/i.test(path)) continue
    const edits: { start: number; end: number; text: string }[] = []
    const schemas: Schema[] = []
    function stateOwner(node: ts.Node) {
      let owner = node.parent
      while (owner !== source && !ts.isFunctionDeclaration(owner) && !ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) owner = owner.parent
      return owner
    }
    // A canvas and the flags/geometry beside it are one resource owner. Detect
    // the native DOM type, including refs and aliases, without PR/file-name rules.
    function holdsCanvas(type: ts.Type): boolean {
      if (type.isUnion()) return type.types.some(holdsCanvas)
      const symbol = type.getSymbol()
      if (symbol !== undefined && ['HTMLCanvasElement', 'OffscreenCanvas'].includes(symbol.name)
        && symbol.declarations?.some(declaration => /lib\.(dom|webworker)\.d\.ts$/.test(declaration.getSourceFile().fileName))) return true
      return false
    }
    const canvasOwners = new Set<ts.Node>()
    function findCanvasOwners(node: ts.Node) {
      if (ts.isVariableDeclaration(node)) {
        const type = checker.getTypeAtLocation(node.name)
        const current = type.getProperty('current')
        if (holdsCanvas(type) || current !== undefined && holdsCanvas(checker.getTypeOfSymbolAtLocation(current, node))) canvasOwners.add(stateOwner(node))
      }
      ts.forEachChild(node, findCanvasOwners)
    }
    findCanvasOwners(source)
    function walk(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isCallExpression(node.initializer)) {
        const call = node.initializer
        const hook = ts.isIdentifier(call.expression) ? call.expression.text
          : ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(source) === 'React' ? call.expression.name.text : ''
        const first = ts.isArrayBindingPattern(node.name) ? node.name.elements[0] : undefined
        const binding = hook === 'useRef' && ts.isIdentifier(node.name) ? node.name
          : hook === 'useState' && first !== undefined && ts.isBindingElement(first) && ts.isIdentifier(first.name) ? first.name : null
        if (binding !== null) {
          const kind = hook === 'useRef' ? 'ref' : 'state'
          const owner = stateOwner(node)
          let ownerName = 'anonymous'
          if (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner)) ownerName = owner.name?.text ?? 'anonymous'
          else if (ts.isArrowFunction(owner) && ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)) ownerName = owner.parent.name.text
          const id = path + ':' + ownerName + ':' + binding.text
          const bindingType = checker.getTypeAtLocation(binding)
          const current = bindingType.getProperty('current')
          const type = kind === 'ref' && current !== undefined ? checker.getTypeOfSymbolAtLocation(current, binding) : bindingType
          const second = ts.isArrayBindingPattern(node.name) ? node.name.elements[1] : undefined
          let policy: Cell['policy'] = 'candidate'
          if (second !== undefined && ts.isBindingElement(second) && ts.isIdentifier(second.name)) {
            const setterName = second.name
            const setter = checker.getSymbolAtLocation(setterName)
            let references = 0, outsideEffect = false
            function uses(candidate: ts.Node) {
              const symbol = ts.isIdentifier(candidate) && ts.isShorthandPropertyAssignment(candidate.parent)
                ? checker.getShorthandAssignmentValueSymbol(candidate.parent)
                : checker.getSymbolAtLocation(candidate)
              if (ts.isIdentifier(candidate) && candidate !== setterName && symbol === setter) {
                references++
                let parent = candidate.parent
                let inEffect = false
                while (parent !== source) {
                  if (ts.isCallExpression(parent) && ['useEffect', 'useLayoutEffect', 'React.useEffect', 'React.useLayoutEffect'].includes(parent.expression.getText(source))) { inEffect = true; break }
                  parent = parent.parent
                }
                if (!inEffect) outsideEffect = true
              }
              ts.forEachChild(candidate, uses)
            }
            uses(owner)
            if (references > 0 && !outsideEffect) policy = 'effect-owned'
          }
          if (canvasOwners.has(owner)) policy = 'canvas-owned'
          let schema: Schema = policy === 'candidate' ? schemaFor(type, binding) : {root:0,nodes:[{kind:'reject',reason:policy + ' state'}]}
          // Keep pure handles local, including null DOM refs and empty callback
          // arrays. Data containers may have unsupported optional/union branches:
          // validate their complete current value instead of discarding the type.
          function carriesData(id: number, seen = new Set<number>()): boolean {
            if (seen.has(id)) return false
            seen.add(id)
            const shape = schema.nodes[id]!
            switch (shape.kind) {
              case 'reject': return false
              case 'data': return true
              case 'primitive': return shape.name !== 'undefined'
              case 'literal': return shape.value !== null
              case 'union': return shape.members.some(member => carriesData(member, seen))
              case 'array': case 'set': return carriesData(shape.item, seen)
              case 'tuple': return shape.items.some(item => carriesData(item, seen))
              case 'map': return carriesData(shape.value, seen)
              case 'object': return shape.fields.some(field => carriesData(field.shape, seen)) || shape.index !== null && carriesData(shape.index, seen)
            }
          }
          if (kind === 'ref' && policy === 'candidate' && schema.nodes.some(shape => shape.kind === 'reject') && !carriesData(schema.root)) {
            policy = 'opaque-ref'
            schema = { root: 0, nodes: [{ kind: 'reject', reason: 'ref holds handles or unsupported values without data' }] }
          }
          const cell: Cell = { id, kind, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, type: checker.typeToString(type), policy, schema }
          cells.push(cell)
          const initial = call.arguments[0]?.getText(source) ?? 'undefined'
          const schemaIndex = schemas.length
          schemas.push(schema)
          edits.push({ start: call.getStart(source), end: call.end, text: (kind === 'ref' ? '__previewRef(' : '__previewState(') + JSON.stringify(id) + ',__previewSchemas[' + schemaIndex + '],' + initial + ')' })
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    if (edits.length === 0) continue
    let result = source.text
    for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
    sources.set(source.fileName, "import { useObservedState as __previewState, useObservedRef as __previewRef } from 'preview-runtime';\nconst __previewSchemas = " + JSON.stringify(schemas) + ';\n' + result)
  }
  return { cells, sources }
}
