# Screeps Leviathan

Screeps Leviathan 是一个使用 TypeScript 开发的 Screeps AI 项目。

主循环由 Leviathan Framework 驱动，当前已接入 RoomShortcuts 服务插件。插件开发与运行配置见 [Framework 使用说明](./docs/usage/core/framework.md)。

## 开发命令

```bash
npm install
npm test
npm run build
```

真实 Screeps 4.3 引擎集成测试与完整本地验证分别使用：

```bash
npm run test:integration
npm run test:all
```

集成环境需要 Node.js 22.12 以上版本（已验证 Node.js 24），首次安装还需要 Git、C/C++
构建工具及由 uv 创建的项目内 Python 虚拟环境。完整准备步骤和场景约定见
[集成测试环境](./docs/testing/integration.md)。

`npm run build` 只构建代码，不需要 `.secret.json`。向验证环境上传代码时使用：

```bash
npm run upload:validation
```

上传配置保存在不会提交到仓库的 `.secret.json` 中，可从 `.secret.json.example` 创建。

## 文档

- [文档总导航](./docs/README.md)：按源码模块查找设计与使用说明。
- [设计方案](./docs/design/README.md)
- [使用说明](./docs/usage/README.md)
- [测试文档](./docs/testing/README.md)
- [更新简讯](./docs/changelog/README.md)

仓库协作和自动化代理约定见 [AGENTS.md](./AGENTS.md)。
