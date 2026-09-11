import ts from 'typescript'

// Mark the receiver, leaving JavaScript's original write expression intact.
// This preserves evaluation order, compound/postfix results, destructuring,
// await/yield and aliases. No application object is wrapped or replaced.
export function instrumentWrites(path: string, text: string) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const targets = new Map<ts.Expression, string | number | null>()
  const opaque: ts.Expression[] = []
  const assignments: ts.BinaryExpression[] = []
  const patterns = new Set<ts.Expression>()
  let unsupported = 0, shadowedGlobal = false
  function target(node: ts.Node, pattern = false) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.SuperKeyword) unsupported++
      else {
        if (pattern) patterns.add(node.expression)
        const field = ts.isPropertyAccessExpression(node) && !ts.isPrivateIdentifier(node.name) ? node.name.text
          : ts.isElementAccessExpression(node) && (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) ? node.argumentExpression.text : null
        if (!targets.has(node.expression) || targets.get(node.expression) !== field) targets.set(node.expression, field)
      }
      return
    }
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) { target(node.expression, pattern); return }
    if (ts.isArrayLiteralExpression(node)) { for (const item of node.elements) target(item, true); return }
    if (ts.isObjectLiteralExpression(node)) {
      for (const item of node.properties) {
        if (ts.isPropertyAssignment(item)) target(item.initializer, true)
        else if (ts.isSpreadAssignment(item)) target(item.expression, true)
      }
      return
    }
    if (ts.isSpreadElement(node)) { target(node.expression); return }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) target(node.left, true)
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression
      const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text
        : ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : ''
      if (name === 'eval') opaque.push(node)
    }
    if (ts.isWithStatement(node)) unsupported++
    if (ts.isIdentifier(node) && node.text === 'globalThis') {
      const parent = node.parent
      if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
        || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)
        || ts.isClassExpression(parent) || ts.isImportClause(parent) || ts.isImportSpecifier(parent)
        || ts.isNamespaceImport(parent)) && parent.name === node) shadowedGlobal = true
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignments.push(node)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target(node.left)
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) target(node.operand)
    if (ts.isDeleteExpression(node)) target(node.expression)
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) target(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  // This parser field is internal to the pinned TypeScript version. Native
  // Function construction validates generated JS before it reaches this pass.
  unsupported += (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length
  if (shadowedGlobal) return { code: text, sites: 0, unsupported: unsupported + targets.size + opaque.length, opaque: opaque.length }
  const wrappers: { start: number; end: number; before: string; after: string }[] = []
  // A lexical receiver can be read again without executing application code.
  // Keep the original assignment and wrap only its RHS. Arguments capture the
  // same receiver before evaluating the RHS, even if it reassigns the binding
  // or suspends. Computed receivers/keys and opaque scopes retain broad marks.
  let precise = 0
  if (unsupported === 0 && opaque.length === 0) for (const assignment of assignments) {
    const left = assignment.left
    if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.expression) || ts.isPrivateIdentifier(left.name) || patterns.has(left.expression) || !lexical(left.expression, source)) continue
    targets.delete(left.expression)
    wrappers.push({ start: assignment.right.getStart(source), end: assignment.right.end,
      before: 'globalThis.__previewWrites.assignment(' + left.expression.text + ',' + JSON.stringify(left.name.text) + ',(', after: '))' })
    precise++
  }
  for (const [node, field] of targets) wrappers.push({ start: node.getStart(source), end: node.end, before: 'globalThis.__previewWrites.touch(', after: field === null ? ')' : ',"property",' + JSON.stringify(field) + ')' })
  for (const node of opaque) wrappers.push({ start: node.getStart(source), end: node.end, before: '(globalThis.__previewWrites.unobserved(),', after: ')' })
  const boundaries = new Map<number, { open: typeof wrappers; close: typeof wrappers }>()
  for (const wrapper of wrappers) {
    const left = boundaries.get(wrapper.start) ?? { open: [], close: [] }, right = boundaries.get(wrapper.end) ?? { open: [], close: [] }
    left.open.push(wrapper); right.close.unshift(wrapper); boundaries.set(wrapper.start, left); boundaries.set(wrapper.end, right)
  }
  let result = '', previous = 0
  for (const [position, boundary] of [...boundaries].sort((a, b) => a[0] - b[0])) {
    result += text.slice(previous, position)
    for (const wrapper of boundary.close.sort((a, b) => b.start - a.start)) result += wrapper.after
    for (const wrapper of boundary.open.sort((a, b) => b.end - a.end)) result += wrapper.before
    previous = position
  }
  return { code: result + text.slice(previous), sites: targets.size + precise, unsupported, opaque: opaque.length }
}

// Native Function#toString supplies the complete parameter/body syntax. Parse
// parameters too: default arguments can mutate existing objects before the body.
export function instrumentGeneratedFunction(text: string) {
  const transformed = instrumentWrites('generated.js', text)
  if (transformed.unsupported !== 0) return { kind: 'unsupported' as const }
  if (transformed.code === text) return { kind: 'unchanged' as const }
  const source = ts.createSourceFile('generated.js', transformed.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const fn = source.statements[0]
  if (source.statements.length !== 1 || fn === undefined || !ts.isFunctionDeclaration(fn) || fn.body === undefined
    || (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length !== 0) return { kind: 'unsupported' as const }
  return { kind: 'instrumented' as const, parameters: transformed.code.slice(fn.parameters.pos, fn.parameters.end), body: transformed.code.slice(fn.body.getStart(source) + 1, fn.body.end - 1) }
}

// Conservative lexical-binding proof; missed bindings only lose the fast path.
// Never duplicate a free/global-property read, a computed key, or an import.
function lexical(identifier: ts.Identifier, source: ts.SourceFile) {
  const name = identifier.text
  function bound(binding: ts.BindingName): boolean {
    return ts.isIdentifier(binding) ? binding.text === name : binding.elements.some(item => ts.isBindingElement(item) && bound(item.name))
  }
  function declarations(list: ts.VariableDeclarationList, functionScope: boolean) {
    return ((list.flags & ts.NodeFlags.BlockScoped) !== 0 || functionScope || ts.isExternalModule(source)) && list.declarations.some(item => bound(item.name))
  }
  let functionScope = false
  for (let parent: ts.Node | undefined = identifier.parent; parent !== undefined; parent = parent.parent) {
    // Method names and decorators execute outside the method's parameter scope.
    if (ts.isComputedPropertyName(parent) || ts.isDecorator(parent)) return false
    if (ts.isFunctionLike(parent)) functionScope = true
  }
  for (let parent: ts.Node | undefined = identifier.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isFunctionLike(parent) && parent.parameters.some(item => bound(item.name))) return true
    if (ts.isCatchClause(parent) && parent.variableDeclaration !== undefined && bound(parent.variableDeclaration.name)) return true
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent) || ts.isForStatement(parent)) && parent.initializer !== undefined && ts.isVariableDeclarationList(parent.initializer) && declarations(parent.initializer, functionScope)) return true
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) for (const statement of parent.statements) {
      if (ts.isVariableStatement(statement) && declarations(statement.declarationList, functionScope)) return true
    }
    // A function's local var scope does not make an outer script's var lexical.
    if (ts.isFunctionLike(parent)) functionScope = false
  }
  return false
}
