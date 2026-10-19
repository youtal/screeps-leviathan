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

/**
 * @description 剥去括号、类型断言、satisfies 与非空断言等语法包装；它们不会改变实际对象，不能成为排除 memory 的证据。
 * @param expression 待剥离的表达式。
 * @returns 去掉全部包装后的内层表达式。
 */
const unwrap = (expression: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
};

/**
 * @description 取出语法上可证的字面量键；动态表达式即使被断言为字面量类型也不能据此放行。
 * @param expression 键表达式。
 * @returns 字符串或数字字面量的文本；不是字面量时为 undefined。
 */
const literalKey = (expression: ts.Expression): string | undefined => {
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) ? value.text : undefined;
};

/**
 * @description 取出对象字面量属性名的静态文本；计算属性名只接受字面量。
 * @param name 属性名节点。
 * @returns 属性名文本；无法静态确定时为 undefined。
 */
const propertyKey = (name: ts.PropertyName): string | undefined => {
  if (ts.isComputedPropertyName(name)) {
    return literalKey(name.expression);
  }
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
};

/**
 * @description 找到节点所在的、直接位于语句块或源文件中的语句；不跨函数边界推测执行时机。
 * @param node 起始节点。
 * @returns 直接所在的语句；途经函数边界或找不到时为 undefined。
 */
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

/**
 * @description 判定 spawnCreep 第三参数是否实际构造了 memory 字段。
 * 仅证明对象字面量、可证展开及同一语句块内的直接赋值；其余来源一律返回 unknown，由调用方诊断。
 * @param options spawnCreep 的第三参数表达式。
 * @param call 所在的 spawnCreep 调用，用于确认参数与调用位于同一源文件。
 * @param checker 解析符号所用的类型检查器。
 * @returns absent 表示可证没有 memory，present 表示可证构造了 memory，unknown 表示无法静态证明。
 */
export const classifySpawnOptions = (
  options: ts.Expression,
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): SpawnOptionsState => {
  // 只记录当前递归链中的本地变量，阻止循环构造无限展开；返回时删除，不作结果缓存。
  const resolving = new Set<ts.Symbol>();

  /**
   * @description 判断子树中是否引用了指定符号（含简写属性），跳过类型节点。
   * @param node 子树根节点。
   * @param symbol 要查找的值符号。
   * @param before 只统计起始位置早于此偏移的引用，默认不限。
   * @returns 找到引用时为 true。
   */
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

  /**
   * @description 判断符号是否被子树中的任何函数（含箭头函数）捕获；被捕获的变量可能在任意时刻被修改。
   * @param node 子树根节点。
   * @param symbol 要检查的值符号。
   * @returns 任一函数体引用了该符号时为 true。
   */
  const captured = (node: ts.Node, symbol: ts.Symbol): boolean => {
    if (ts.isFunctionLike(node)) {
      return hasReference(node, symbol);
    }
    return ts.forEachChild(node, (child) => captured(child, symbol) || undefined) ?? false;
  };

  /**
   * @description 判定对象字面量是否构造了 memory：逐个检查属性与展开，明确出现 memory 即为 present。
   * @param object 对象字面量。
   * @returns 属性集合的判定结果；含动态键、__proto__、访问器或无法证明的展开时为 unknown。
   */
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

  /**
   * @description 判定变量初始化或重新赋值的值；只跟随新对象构造，直接以其他变量初始化会共享身份，按别名处理。
   * @param expression 初始化或赋值表达式；省略时视为无法证明。
   * @returns 是对象字面量时为其判定结果，否则为 unknown。
   */
  const constructed = (expression: ts.Expression | undefined): SpawnOptionsState => {
    const value = expression && unwrap(expression);
    return value && ts.isObjectLiteralExpression(value) ? objectState(value) : 'unknown';
  };

  /**
   * @description 判定本地变量引用处的对象是否含 memory：要求声明与引用位于同一语句块，
   * 依次跟踪其间的整体重新赋值与字面量键属性赋值；遇到别名、闭包捕获或无法识别的写法即为 unknown。
   * @param reference 作为 spawnCreep 第三参数的变量引用。
   * @returns 引用处对象的判定结果。
   */
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

  /**
   * @description 按表达式形式分派判定：对象字面量、void 与内建 undefined、本地变量引用，其余为 unknown。
   * @param expression 待判定的表达式。
   * @returns 判定结果。
   */
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
