import ts from 'typescript'

// Mark the receiver, leaving JavaScript's original write expression intact.
// This preserves evaluation order, compound/postfix results, destructuring,
// await/yield and aliases. No application object is wrapped or replaced.
export function instrumentWrites(path: string, text: string) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const targets = new Map<ts.Expression, string | number | null>()
  const opaque: ts.Expression[] = []
  let unsupported = 0, shadowedGlobal = false
  function target(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.SuperKeyword) unsupported++
      else {
        const field = ts.isPropertyAccessExpression(node) && !ts.isPrivateIdentifier(node.name) ? node.name.text
          : ts.isElementAccessExpression(node) && (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) ? node.argumentExpression.text : null
        if (!targets.has(node.expression) || targets.get(node.expression) !== field) targets.set(node.expression, field)
      }
      return
    }
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) { target(node.expression); return }
    if (ts.isArrayLiteralExpression(node)) { for (const item of node.elements) target(item); return }
    if (ts.isObjectLiteralExpression(node)) {
      for (const item of node.properties) {
        if (ts.isPropertyAssignment(item)) target(item.initializer)
        else if (ts.isSpreadAssignment(item)) target(item.expression)
      }
      return
    }
    if (ts.isSpreadElement(node)) { target(node.expression); return }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) target(node.left)
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression
      const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text
        : ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : ''
      if (name === 'eval' || name === 'Function' || name === 'constructor') {
        const args = node.arguments
        const body = args?.length === 1 && args[0] !== undefined && ts.isStringLiteral(args[0]) ? ts.createSourceFile('generated.js', args[0].text, ts.ScriptTarget.Latest) : undefined
        const statement = body?.statements.length === 1 ? body.statements[0] : undefined
        const lookup = name === 'Function' && statement !== undefined && ts.isReturnStatement(statement) && statement.expression?.kind === ts.SyntaxKind.ThisKeyword
        if (!lookup) opaque.push(node)
      }
    }
    if (ts.isIdentifier(node) && node.text === 'globalThis') {
      const parent = node.parent
      if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
        || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)
        || ts.isClassExpression(parent) || ts.isImportClause(parent) || ts.isImportSpecifier(parent)
        || ts.isNamespaceImport(parent)) && parent.name === node) shadowedGlobal = true
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target(node.left)
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) target(node.operand)
    if (ts.isDeleteExpression(node)) target(node.expression)
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) target(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (shadowedGlobal) return { code: text, sites: 0, unsupported: unsupported + targets.size, opaque: opaque.length }
  const wrappers: { start: number; end: number; before: string; after: string }[] = []
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
  return { code: result + text.slice(previous), sites: targets.size, unsupported, opaque: opaque.length }
}
