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

## 安装与隔离边界

宿主使用 Node.js 24、npm 12 和 Docker Engine。日常安装只需要：

```bash
npm ci --ignore-scripts
npm test
npm run build
```

根 package/lockfile 不安装 Screeps 引擎；旧引擎依赖及脚本许可单独放在
[`test/integration/runner/`](../../test/integration/runner/)，只在 Docker 构建中安装。
无需在宿主安装 C++ 工具链或 Python 虚拟环境。Node 基础镜像固定 digest，runner 锁文件固定 npm/Git
依赖；升级时核对 digest、锁文件和安装脚本白名单，不能执行 `audit fix --force` 强换 lodash 主版本。

`build/runIntegration.mjs` 先建立白名单临时构建上下文，只包含 runner 清单、Dockerfile、正式产物、
场景、共享辅助文件和专用配置；拒绝符号链接。仓库源码、`.git`、根 `.npmrc`、`.secret.json` 和
宿主 node_modules 不进入镜像。安装脚本执行层尚未复制测试脚本和产物，构建不传 npm/Git 凭据。

测试容器以 UID/GID 1000 运行，根文件系统只读，丢弃全部 capabilities，禁止提权和外部网络；
只保留容器自身 loopback，供 storage/runner/processor 通信。容器不挂载宿主目录或 Docker socket，
不发布端口，不转发宿主环境变量；限制 CPU、内存和进程数。`/tmp`、`/work` 为有界 tmpfs。
这些控制降低开发机暴露面，不表示旧依赖漏洞已消失，也不构成对任意恶意依赖的绝对隔离证明。

## 运行与配置

```bash
# 构建正式产物，自动构建隔离镜像并运行所有场景
npm run test:integration

# 只运行一个场景
npm run test:integration -- --only leviathan-runtime

# 分别扫描日常依赖与隔离引擎依赖
npm audit
npm audit --prefix test/integration/runner
```

首次执行会下载基础镜像、安装依赖并编译原生扩展；后续复用 Docker 构建缓存。
Docker 不可用时明确失败，不退回宿主运行。镜像使用本次进程的临时 tag，测试结束移除 tag；
构建层缓存保留供后续使用，不清理其他项目镜像。

根目录 `screeps-integration.config.cjs` 从镜像 `/opt/runner` 读取正式产物和场景，保持 `jobs: 1`。
数据库、性能报告分别写入容器 `/work/cache`、`/work/profiles`，引擎日志写入 `/work/server/logs`。
场景通过共享 harness 在失败时把现场附到异常；日志与汇总输出到终端，可由 CI 保存。
容器退出即删除临时文件，本入口不导出宿主可写目录；无需开放宿主回环监听权限。

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

场景通过 `../support/harness.js` 复用三件事：`loadProductionModules()` 装载正式产物并在内存中追加
heap 探针、`assertRuntimeClean()` 统一错误口径、`withWorld()` 保证 dispose 且在失败时附上引擎现场。

当前场景：

| 场景                     | 覆盖内容                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `leviathan-runtime`      | 正式 bundle 装载、连续 tick、生产 loop 计数、可见房间、CPU API、游戏内 sourcemap、空 Memory                |
| `leviathan-global-reset` | 旧 `leviathan` 布局与无关根字段原样保留、跨 global 的 Memory 继承与 heap 重建、未知 schemaVersion 拒绝覆盖 |
| `leviathan-segments`     | Segment 激活后跨 tick 读写、按页隔离、单页承载 `SEGMENT_CAPACITY` 的往返完整性                             |

三个场景都在内存里的 main 模块末尾追加 heap 计数器，不改写 `dist/`，也不会进入部署产物。
`leviathan-global-reset` 用「世界 A 运行 → Memory 快照 → 世界 B 以快照启动」等价表达一次 global
reset：新 isolate 的探针必须从 1 重新计数（若 heap 被继承会得到阶段 1 的累计值），Memory 则必须
原样继承。它同时验证 `src/core/memoryManager/namespace.ts` 的两条持久化契约——旧布局只读保留、
未知 `schemaVersion` 报告诊断且不写入任何存储；后者期望日志中出现
`storage load failed: Unsupported MemoryManager schema`，属于**预期内**诊断，不算运行错误。

**错误口径**：框架自带的 `report.errors` 只按硬编码模式分类（`TypeError:`、`is not defined` 等），
普通 `throw new Error('...')` 不会进入其中，只留在 `report.logs`。因此场景应使用
`assertRuntimeClean()` 而不是直接依赖 `assertNoErrors()`，并显式设置 `logLevel: 'all'` 以便日志扫描
有效；`withWorld()` 在失败时会把抛出型错误前置到异常消息，避免只看到 `evalInBot` 超时。

## 已知边界

- Screeps 私服及其构建链包含多个停止维护的传递依赖，`npm audit --prefix test/integration/runner` 会报告上游遗留漏洞。该依赖树
  仅用于隔离容器，不得在宿主直接安装或作为对外服务运行；处置及复查见 [P1 整改记录](../audits/2026-09-19-p1-remediation.md)；
- mockup 的 storage 连接不能在同一 Node 进程内完全释放，隔离 worker 退出是当前清理机制；
- 框架未提供“保留同一 storage 并只重启玩家 isolate”的 API，global reset 只能按
  `leviathan-global-reset` 的等价方式验证。heap 重建与 Memory 继承是可观测契约，但**主 RawMemory 与
  Segment 之间的分区搬迁、journal 迁移与恢复仍未覆盖**：这些路径需要通过 context.memory 申请分区的业务插件，
  当前生产 bundle 只有不声明持久化的 `roomShortcuts`，命名空间只存在于 heap，不会写回 Memory；
- **Segment 语义与线上不同**（由 `leviathan-segments` 实测）：本环境不强制 `setActiveSegments`
  前置条件，未激活也能直接读写；`RawMemory.get().activeSegments` 恒为 `null`；单页写入约 12 万字符
  会让 isolate 崩溃而不是抛出可捕获错误。因此“超限拒绝写入并保留旧数据”的失败路径与 MemoryManager
  的 `pending`/激活延迟分支**无法在本环境验证**，必须在真实服务器复核；单页 100 KB 口径目前只验证了
  `SEGMENT_CAPACITY` 这个合法上界可以完整往返；
- npm 包没有 TypeScript 声明，项目使用 JavaScript scenario 与 CLI 隔离这项限制；
- 完整私服的 backend、上传接口和多进程 launcher 兼容性需要未来独立的端到端环境覆盖。

排错时先看命令输出中的失败场景和附带引擎日志。`EACCES` 应核验 COPY 文件归属与 node 用户权限，
不能通过 privileged/root 运行绕过。若缺少 driver runtime bundle，应核对 runner 的安装脚本白名单和
Docker 构建日志，再重建镜像；不要在宿主执行旧引擎安装脚本。新环境首次运行需允许 Docker 构建联网，
测试运行阶段仍保持 `--network=none`。
