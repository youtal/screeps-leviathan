# Screeps 引擎集成测试

[测试文档](./README.md) · [项目首页](../../README.md) · [场景源码](../../test/integration/scenarios/)

## 覆盖范围

集成测试使用 `screeps-integration-tests@3.0.0`，通过
`@cool-andre/screeps-server-mockup@1.5.2` 启动 Screeps storage、engine runner 与 processor，
再用 `server.tick()` 确定性推进游戏。测试装载 `npm run build` 生成的正式 `dist/main.js`，可验证
玩家 isolate、`Game` API、CPU 计量、intent 处理、Memory 和游戏对象随 tick 的真实行为。

该环境不启动 launcher、backend、HTTP API、认证或 WebSocket，因此属于真实引擎集成测试，
不代替完整私服端到端测试。依赖版本由 `package-lock.json` 固定；本次锁定的关键运行组件为
Screeps 4.3.0、driver 5.3.0、engine 4.3.2、common 2.16.1 与 storage 5.1.3。

现有测试分为三层：

| 命令                       | 环境                | 用途                                     |
| -------------------------- | ------------------- | ---------------------------------------- |
| `npm test`                 | Jest 与 `node:vm`   | 快速验证模块、构建插件和 bundle 沙箱契约 |
| `npm run test:integration` | 真实 Screeps engine | 构建后执行所有 `*.scenario.js` 场景      |
| `npm run test:all`         | 以上两层            | 提交前完整本地回归                       |

## 首次安装

需要 Node.js 22.12 或更高版本、Git、C/C++ 构建工具和 uv；本项目以 Node.js 24 验证。官方
`@screeps/driver` 依赖固定 Git commit 的 `isolated-vm`，并需要 Python 驱动 node-gyp。先在
仓库根目录创建虚拟环境，再安装依赖：

```bash
UV_CACHE_DIR=/tmp/screeps-leviathan-uv-cache uv venv .venv --python 3.13
PYTHON="$PWD/.venv/bin/python" npm ci
```

`.venv/` 已加入 `.gitignore`，不得提交。`UV_CACHE_DIR` 把 uv 下载缓存放在临时目录；也可以换成
开发机可写的其他缓存路径。

npm 12 默认拒绝 Git 依赖，项目级 `.npmrc` 因官方 driver 的传递依赖设置
`allow-git=all`。这项权限只负责获取 Git 包；Git 依赖由 lockfile 中的仓库 URL 与 commit 固定，
registry 包另由版本和完整性摘要约束。`package.json` 的 `allowScripts` 只批准以下固定安装脚本：

- Node 24 兼容版 `isolated-vm` 的原生编译；
- `@screeps/driver@5.3.0` 的原生扩展；
- `screeps@4.3.0` 的 runtime bundle 与 snapshot 生成；
- Screeps 旧构建链所需的 `uglifyjs-webpack-plugin@0.4.6` 与 `es5-ext@0.10.64`。

更新 Screeps 或 lockfile 后，应重新检查 `npm install-scripts ls`，不得批量批准未知脚本。安装成功时
应存在 `node_modules/@screeps/driver/build/runtime.bundle.js` 和 `runtime.snapshot.bin`；缺失时说明
Screeps postinstall 没有执行。当前安装会报告 `@parcel/watcher` 与 `unrs-resolver` 的脚本被阻止；
集成场景不依赖这两个脚本生成的产物，因此无需批准。

## 运行与配置

```bash
# 构建正式产物并运行全部真实引擎场景
npm run test:integration

# 只运行一个场景，名称不含 .scenario.js
npm run build
npx screeps-integration-tests \
  --config screeps-integration.config.cjs \
  --only leviathan-runtime
```

根目录 `screeps-integration.config.cjs` 将场景固定为串行执行，并把私服数据库、日志和性能输出写入
`test/integration/.cache/` 与 `test/integration/profiles/`。两者均已忽略。测试会监听本机回环地址的
临时端口；受限沙箱需要授予本地监听权限，普通终端和 CI 可直接运行。

每个场景由 CLI 放入独立子进程。场景内部仍须用 `try/finally` 调用 `world.dispose()`；worker 在
场景结束后退出，以回收 mockup 的 storage 单例残留。配置保持 `jobs: 1`，只有确认目标 CI 的端口、
CPU 与 storage 隔离稳定后才能提高并发。

## 场景约定

场景位于 `test/integration/scenarios/`，使用 CommonJS 并以 `.scenario.js` 结尾，导出异步 `run()`。
新增场景应遵守以下边界：

- 测试正式 `dist/main.js`，不要重新实现一份 bot 主循环；
- 若要验证错误映射，必须把 `dist/main.js.map` 包装成名为 `main.js.map` 的 Screeps 模块；框架默认
  的 dist 扫描只装载 `.js` 文件；
- 用世界对象、event log、console 结果或测试专用 heap 探针证明行为，不向生产 Memory schema
  注入永久测试字段；
- 不使用 `assertBotWorked()` 判断本项目是否启动。该断言要求 Memory 非空，而 Leviathan 在没有
  持久化分区时会有意保持 `{}`；
- `src/` 中的 Memory 访问仍严格经过 `core/memoryManager`。测试脚本可以从 harness 注入或读取
  玩家存储，但不得因此给业务模块增加旁路；
- 所有时间、CPU 和对象断言使用语义范围，避免依赖机器速度、随机 ID 或私服内部排序。

`leviathan-runtime.scenario.js` 当前覆盖正式 bundle 装载、连续三 tick、生产 loop 执行次数、可见
房间、CPU API、游戏内 sourcemap 模块和空 Memory 语义。它在内存里的 main 模块末尾追加 heap
计数器，不改写 `dist/`，也不会进入部署产物。

## 已知边界

- Screeps 私服及其构建链包含多个停止维护的传递依赖，`npm audit` 会报告上游遗留漏洞。该依赖树
  仅用于本地或 CI 测试，不应作为对外服务运行；升级或替换服务端版本时需重新审计；
- mockup 的 storage 连接不能在同一 Node 进程内完全释放，隔离 worker 退出是当前清理机制；
- 框架暂未提供“保留同一 storage 并只重启玩家 isolate”的 global reset API；跨 global 恢复仍需
  单独扩展 harness 后验证；
- RawMemory Segment 可由真实引擎提供，但当前首个场景没有申请持久化分区，因此尚未覆盖 Segment
  激活、写回和 global reset 恢复；
- npm 包没有 TypeScript 声明，项目使用 JavaScript scenario 与 CLI 隔离这项限制；
- 完整私服的 backend、上传接口和多进程 launcher 兼容性需要未来独立的端到端环境覆盖。

排错时先检查场景对应的 `.cache` 子目录日志，再确认 driver runtime bundle 是否存在。若出现
`listen EPERM`，应开放本机回环监听；若出现 `Cannot find module '../../build/runtime.bundle.js'`，
应重新用项目虚拟环境执行 `PYTHON="$PWD/.venv/bin/python" npm ci`。
