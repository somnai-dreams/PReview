import ts from 'typescript'

// Mark the receiver, leaving JavaScript's original write expression intact.
// This preserves evaluation order, compound/postfix results, destructuring,
// await/yield and aliases. No application object is wrapped or replaced.
export function instrumentWrites(path: string, text: string) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const targets = new Set<ts.Expression>()
  let unsupported = 0, shadowedGlobal = false
  function target(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.SuperKeyword) unsupported++
      else targets.add(node.expression)
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
  if (shadowedGlobal) return { code: text, sites: 0, unsupported: unsupported + targets.size }
  const boundaries = new Map<number, { open: number; close: number }>()
  for (const node of targets) {
    const start = node.getStart(source), end = node.end
    const left = boundaries.get(start) ?? { open: 0, close: 0 }, right = boundaries.get(end) ?? { open: 0, close: 0 }
    left.open++; right.close++; boundaries.set(start, left); boundaries.set(end, right)
  }
  let result = '', previous = 0
  for (const [position, boundary] of [...boundaries].sort((a, b) => a[0] - b[0])) {
    result += text.slice(previous, position) + ')'.repeat(boundary.close) + 'globalThis.__previewWrites.touch('.repeat(boundary.open)
    previous = position
  }
  return { code: result + text.slice(previous), sites: targets.size, unsupported }
}
