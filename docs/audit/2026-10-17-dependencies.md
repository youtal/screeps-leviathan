# 2026-10-17 依赖安全审计

| 项目 | 内容 |
| --- | --- |
| 代码基线 | `dev` 分支 `f4c77c4`（0.1.1） |
| 范围 | npm 依赖（`npm audit`） |
| 结论 | 发现 1 个问题，已解决；无遗留，无挂起 |

## 1. 发现

| 编号 | 级别 | 问题 | 证据 |
| --- | --- | --- | --- |
| D01 | 中 | `sprintf-js` 拒绝服务漏洞（GHSA-hp3w-g68c-fv3c），影响全部已发布版本（≤ 1.1.3），没有修复版本。`npm audit` 把依赖链上的 20 个包都报为中等风险 | 源码确认，见第 2 节 |

## 2. 分析

依赖链：

```text
ts-jest → @jest/transform → babel-plugin-istanbul → @istanbuljs/load-nyc-config
  → js-yaml@3.15.2 → argparse@1.0.10 → sprintf-js@1.0.3
```

- **影响范围**：这条链只在开发时的测试工具中使用，不进入构建产物，也不处理外部输入。
- **`argparse` 的使用者**：在 `js-yaml` 3.15.2 中，只有命令行工具 `node_modules/js-yaml/bin/js-yaml.js` 引用 `argparse`，库代码不引用；`argparse` 在依赖树中只有 `js-yaml` 一个使用者。
- **实际调用**：`@istanbuljs/load-nyc-config` 只调用 `js-yaml` 的库函数 `load`（`node_modules/@istanbuljs/load-nyc-config/index.js` 第 80 行）。
- **`npm audit` 的修复建议**：回退 Jest 与 ts-jest 的主版本，不可取。

## 3. 处置

在 `package.json` 中增加 `overrides`，只替换 `js-yaml` 3.x 名下的 `argparse`：

```json
"overrides": { "js-yaml@3": { "argparse": "2.0.1" } }
```

- `argparse` 2.0.1 没有依赖，`sprintf-js` 随之从依赖树中移除。
- 代价：`js-yaml` 3.x 的命令行工具与 `argparse` 2.x 不兼容。项目不使用该命令行工具，库函数不受影响。
- **撤销条件**：依赖树中不再出现 `js-yaml` 3.x（例如上游改用 `js-yaml` 4）时，删除这条 `overrides`。

## 4. 验证

| 检查 | 结果 |
| --- | --- |
| `npm audit` | 0 vulnerabilities |
| `npm ls argparse sprintf-js --all` | `argparse@2.0.1 overridden`；`sprintf-js` 不再出现 |
| `require('js-yaml').load('a: 1\nb: [x, y]')` | 解析为 `{"a":1,"b":["x","y"]}` |
| `npm run check` | 类型检查、14 个单元测试、构建均通过 |
