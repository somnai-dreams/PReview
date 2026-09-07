import ts from 'typescript'
import { relative, resolve } from 'node:path'

type Shape =
  | { kind: 'reject'; reason: string }
  | { kind: 'primitive'; name: string }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'union'; members: number[] }
  | { kind: 'array' | 'set'; item: number }
  | { kind: 'object'; fields: { name: string; optional: boolean; shape: number }[]; index: number | null }
export type Schema = { root: number; nodes: Shape[] }
export type Cell = { id: string; line: number; type: string; policy: 'candidate' | 'effect-owned' | 'canvas-owned'; schema: Schema }

export function prepare(checkout: string) {
  const configPath = resolve(checkout, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, checkout)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const cells: Cell[] = []
  const sources = new Map<string, string>()

  function schemaFor(root: ts.Type): Schema {
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
      if (type.flags & ts.TypeFlags.StringLiteral) return finish({ kind: 'literal', value: (type as ts.StringLiteralType).value })
      if (type.flags & ts.TypeFlags.NumberLiteral) return finish({ kind: 'literal', value: (type as ts.NumberLiteralType).value })
      if (type.flags & ts.TypeFlags.BooleanLiteral) return finish({ kind: 'literal', value: checker.typeToString(type) === 'true' })
      if (type.flags & ts.TypeFlags.Null) return finish({ kind: 'literal', value: null })
      for (const [flag, name] of [[ts.TypeFlags.String, 'string'], [ts.TypeFlags.Number, 'number'], [ts.TypeFlags.Boolean, 'boolean'], [ts.TypeFlags.Undefined, 'undefined']] as const) {
        if (type.flags & flag) return finish({ kind: 'primitive', name })
      }
      if (type.isUnion()) return finish({ kind: 'union', members: type.types.map(visit) })
      if (checker.isArrayType(type)) {
        const item = checker.getTypeArguments(type as ts.TypeReference)[0]
        return finish(item === undefined ? { kind: 'reject', reason: 'array element' } : { kind: 'array', item: visit(item) })
      }
      const symbol = type.getSymbol()
      if (symbol?.name === 'Set' || symbol?.name === 'ReadonlySet') {
        const item = checker.getTypeArguments(type as ts.TypeReference)[0]
        return finish(item === undefined ? { kind: 'reject', reason: 'set element' } : { kind: 'set', item: visit(item) })
      }
      if (!(type.flags & ts.TypeFlags.Object) || checker.isTupleType(type) || type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0 || symbol?.declarations?.some(ts.isClassDeclaration)) {
        return finish({ kind: 'reject', reason: checker.typeToString(type) })
      }
      const properties = type.getProperties()
      const stringIndex = type.getStringIndexType()
      if (properties.length === 0 && stringIndex === undefined) return finish({ kind: 'reject', reason: 'opaque object' })
      const fields: { name: string; optional: boolean; shape: number }[] = []
      for (const property of properties) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0]
        if (declaration === undefined || ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) return finish({ kind: 'reject', reason: 'method' })
        fields.push({ name: property.name, optional: (property.flags & ts.SymbolFlags.Optional) !== 0, shape: visit(checker.getTypeOfSymbolAtLocation(property, declaration)) })
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
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer !== undefined && ts.isCallExpression(node.initializer)) {
        const call = node.initializer
        const isState = ts.isIdentifier(call.expression) && call.expression.text === 'useState'
          || ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'useState' && call.expression.expression.getText(source) === 'React'
        const first = node.name.elements[0]
        if (isState && first !== undefined && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
          const owner = stateOwner(node)
          let ownerName = 'anonymous'
          if (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner)) ownerName = owner.name?.text ?? 'anonymous'
          else if (ts.isArrowFunction(owner) && ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)) ownerName = owner.parent.name.text
          const id = path + ':' + ownerName + ':' + first.name.text
          const type = checker.getTypeAtLocation(first.name)
          const second = node.name.elements[1]
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
          const schema: Schema = policy === 'candidate' ? schemaFor(type) : {root:0,nodes:[{kind:'reject',reason:policy + ' state'}]}
          const cell = { id, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, type: checker.typeToString(type), policy, schema }
          cells.push(cell)
          const initial = call.arguments[0]?.getText(source) ?? 'undefined'
          const schemaIndex = schemas.length
          schemas.push(schema)
          edits.push({ start: call.getStart(source), end: call.end, text: '__previewState(' + JSON.stringify(id) + ',__previewSchemas[' + schemaIndex + '],' + initial + ')' })
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    if (edits.length === 0) continue
    let result = source.text
    for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
    sources.set(source.fileName, "import { useObservedState as __previewState } from 'preview-runtime';\nconst __previewSchemas = " + JSON.stringify(schemas) + ';\n' + result)
  }
  return { cells, sources }
}
