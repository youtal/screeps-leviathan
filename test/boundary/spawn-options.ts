/**
 * 文件摘要：静态区分 spawnCreep 选项是否实际构造了 memory，避免把可选类型成员当成赋值。
 * 所属位置：test/boundary/，只服务开发期边界检查，不进入游戏构建产物。
 * 输入：第三参数表达式、所在调用与 TypeScript 类型检查器；输出 absent / present / unknown。
 * 仅证明对象字面量、可证展开及同一语句块内的直接赋值；包装类型不提供运行时证明。
 * 参数、函数结果、动态键、别名、逃逸、闭包、模块顶层绑定及复杂控制流返回 unknown，由调用方诊断。
 * 不做跨函数或跨块数据流；每次检查仅持有本次递归路径，既无跨调用缓存，也无游戏状态副作用。
 */
import ts from 'typescript';

export type SpawnOptionsState = 'absent' | 'present' | 'unknown';

/** 类型断言及语法包装不会改变实际对象，不能成为排除 memory 的证据。 */
const unwrap = (expression: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
};

/** 只认语法可证的键；动态表达式即使被断言为字面量类型也不能据此放行。 */
const literalKey = (expression: ts.Expression): string | undefined => {
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) ? value.text : undefined;
};

const propertyKey = (name: ts.PropertyName): string | undefined => {
  if (ts.isComputedPropertyName(name)) {
    return literalKey(name.expression);
  }
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
};

/** 找到当前执行位置的直接语句；不跨函数边界推测执行时机。 */
const statementAt = (node: ts.Node): ts.Statement | undefined => {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      return undefined;
    }
    if (current.parent && (ts.isBlock(current.parent) || ts.isSourceFile(current.parent))) {
      return ts.isStatement(current) ? current : undefined;
    }
  }
  return undefined;
};

export const classifySpawnOptions = (
  options: ts.Expression,
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): SpawnOptionsState => {
  // 只记录当前递归链中的本地变量，阻止循环构造无限展开；返回时删除，不作结果缓存。
  const resolving = new Set<ts.Symbol>();

  const hasReference = (node: ts.Node, symbol: ts.Symbol, before = Infinity): boolean => {
    if (ts.isTypeNode(node) || node.getStart() >= before) {
      return false;
    }
    // 简写属性的 name 绑定到属性符号；实际逃逸的是它引用的局部值符号。
    if (ts.isShorthandPropertyAssignment(node) && checker.getShorthandAssignmentValueSymbol(node) === symbol) {
      return true;
    }
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      return true;
    }
    return ts.forEachChild(node, (child) => hasReference(child, symbol, before) || undefined) ?? false;
  };

  const captured = (node: ts.Node, symbol: ts.Symbol): boolean => {
    if (ts.isFunctionLike(node)) {
      return hasReference(node, symbol);
    }
    return ts.forEachChild(node, (child) => captured(child, symbol) || undefined) ?? false;
  };

  const objectState = (object: ts.ObjectLiteralExpression): SpawnOptionsState => {
    let state: SpawnOptionsState = 'absent';
    for (const property of object.properties) {
      let part: SpawnOptionsState;
      if (ts.isSpreadAssignment(property)) {
        // 在展开处求值，之后对原对象的赋值不会改变已构造副本的属性集合。
        part = classify(property.expression);
      } else {
        const key = propertyKey(property.name);
        part = key === 'memory' ? 'present'
          : key === undefined || key === '__proto__' || ts.isGetAccessorDeclaration(property)
            || ts.isSetAccessorDeclaration(property) ? 'unknown' : 'absent';
      }
      // 对象展开不会删除已构造的键；明确出现 memory 时，其余未知属性不能使它消失。
      if (part === 'present') {
        return 'present';
      }
      if (part === 'unknown') {
        state = 'unknown';
      }
    }
    return state;
  };

  /** 本地绑定只跟随新对象构造；直接以其他变量初始化会共享身份，按别名处理。 */
  const constructed = (expression: ts.Expression | undefined): SpawnOptionsState => {
    const value = expression && unwrap(expression);
    return value && ts.isObjectLiteralExpression(value) ? objectState(value) : 'unknown';
  };

  const localState = (reference: ts.Identifier): SpawnOptionsState => {
    const symbol = checker.getSymbolAtLocation(reference);
    const declaration = symbol?.valueDeclaration;
    if (!symbol || !declaration || !ts.isVariableDeclaration(declaration)
      || !ts.isIdentifier(declaration.name) || resolving.has(symbol)) {
      return 'unknown';
    }
    const start = statementAt(declaration);
    const end = statementAt(reference);
    if (!start || !end || !ts.isVariableStatement(start) || start.parent !== end.parent
      || !ts.isBlock(start.parent)
      || !(ts.isExpressionStatement(end) || ts.isReturnStatement(end) || ts.isVariableStatement(end))) {
      return 'unknown';
    }
    const statements = start.parent.statements;
    const startIndex = statements.indexOf(start);
    const endIndex = statements.indexOf(end);
    if (startIndex >= endIndex || captured(start.parent, symbol)) {
      return 'unknown';
    }
    resolving.add(symbol);
    try {
      let state = constructed(declaration.initializer);
      // 同一声明语句中的后续声明可能取得别名，不能漏掉这种逃逸。
      for (const sibling of start.declarationList.declarations) {
        if (sibling.pos > declaration.pos && hasReference(sibling, symbol)) {
          state = 'unknown';
        }
      }
      for (let index = startIndex + 1; index < endIndex; index += 1) {
        const statement = statements[index];
        if (!hasReference(statement, symbol)) {
          continue;
        }
        const expression = ts.isExpressionStatement(statement) ? unwrap(statement.expression) : undefined;
        if (!expression || !ts.isBinaryExpression(expression)
          || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || hasReference(expression.right, symbol)) {
          state = 'unknown';
          continue;
        }
        const target = unwrap(expression.left);
        if (ts.isIdentifier(target) && checker.getSymbolAtLocation(target) === symbol) {
          // 换成新的对象后，旧对象的别名不再影响新对象；闭包捕获已经在前面整体拒绝。
          state = constructed(expression.right);
          continue;
        }
        const receiver = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)
          ? unwrap(target.expression) : undefined;
        if (!receiver || !ts.isIdentifier(receiver) || checker.getSymbolAtLocation(receiver) !== symbol) {
          state = 'unknown';
          continue;
        }
        const key = ts.isPropertyAccessExpression(target) ? target.name.text
          : ts.isElementAccessExpression(target) ? literalKey(target.argumentExpression) : undefined;
        if (key === undefined || key === '__proto__') {
          state = 'unknown';
        } else if (key === 'memory' && state !== 'unknown') {
          state = 'present';
        }
      }
      // 同一调用较早求值的参数或对象字段也可能取得别名；只看当前引用之前的部分。
      return hasReference(end, symbol, reference.getStart()) ? 'unknown' : state;
    } finally {
      resolving.delete(symbol);
    }
  };

  const classify = (expression: ts.Expression): SpawnOptionsState => {
    const value = unwrap(expression);
    if (ts.isObjectLiteralExpression(value)) {
      return objectState(value);
    }
    if (ts.isVoidExpression(value)) {
      return 'absent';
    }
    if (ts.isIdentifier(value)) {
      // 内建 undefined 没有用户声明；同名参数或局部变量仍按动态来源处理。
      if (value.text === 'undefined' && !checker.getSymbolAtLocation(value)?.declarations?.length
        && checker.getTypeAtLocation(value).flags & ts.TypeFlags.Undefined) {
        return 'absent';
      }
      return localState(value);
    }
    return 'unknown';
  };

  return options.getSourceFile() === call.getSourceFile() ? classify(options) : 'unknown';
};
