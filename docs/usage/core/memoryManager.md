# MemoryManager 使用说明

`createMemoryManager` 提供持久化存储：模块按稳定身份申请分区，通过 `MemoryAccessor` 每 tick 判断就绪状态并读写自己的数据。Runtime 负责组装，Framework 在 tick 边界驱动 `begin/end`；模块不接触 RawMemory 与 Segment。

```ts
import { createFramework } from '@/core/framework';
import { createRuntime } from '@/core/runtime';

const runtime = createRuntime();
const framework = createFramework({ runtime, plugins: [myPlugin] });
export const loop = framework.loop;
```

## 在插件中使用

```ts
import type { MemoryAccessor } from '@/contracts/memory';

interface State {
  lastTick: number;
  jobs: string[];
}

let state: MemoryAccessor<State> | undefined;

const plugin: LeviathanPlugin = {
  manifest: { id: 'logistics', version: 1 },
  setup(context) {
    // 申请在 setup 中完成：身份稳定，重复装配返回同一句柄。
    state = context.memory('main', {
      version: 1,
      layer: 'critical',
      initialize: () => ({ lastTick: 0, jobs: [] }),
    });
  },
  onTickExecute(context) {
    const access = state!.access();
    if (access.status === 'pending') {
      // 只跳过依赖 Memory 的行为，其它决策照常执行；不要缓存旧 ready 句柄。
      context.env.log.debug(`memory pending: ${access.reason}`);
    } else {
      const snapshot = access.query();          // 类型级深只读
      access.commit((memory) => {               // 原地修改，回调同步
        memory.lastTick = context.tick;
        memory.jobs = snapshot.jobs.slice(0, 8);
      });
    }
    runIndependentWork(context);
  },
};
```

要点：

- `context.memory(localId, options)` 由框架按 `pluginId` 绑定 owner；`localId` 默认用 `'main'`，支持一个模块多份分区。
- 句柄（`MemoryAccessor`）可以跨 tick 保存；`access()` 的 ready 视图与数据引用只对签发它的 tick 有效。跨 tick、分区进入 pending 或数据被重新加载后再调用 `query()/commit()` 会抛协议错误——必须每 tick 重新 `access()` 并重新收窄状态。
- `query()` 只提供类型级只读，不冻结对象；`commit()` 在回调前标脏，回调抛错不回滚，返回成功也不代表已落盘。
- 不需要跨 global 保留的数据不要申请分区：闭包缓存更省 CPU 与容量。

## 申请配置（MemoryApplicationOptions）

| 配置 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | 正整数数据版本；升级时调用 `migrate`，降级被拒绝 |
| `initialize()` | 是 | 没有历史数据时生成初始数据；必须返回键值对象 |
| `migrate(memory, fromVersion)` | 升级时 | 接收未知旧数据，自行校验并返回新形状；**只要存储里已有该分区的数据就必须提供**（含旧布局导入的版本 0——它表示"未知旧版本"，不会被当成新安装） |
| `layer` | 是 | `critical` 当 tick 提交；`checkpoint` 按间隔合并提交 |
| `checkpointInterval` | 否 | 仅 checkpoint 可用，正整数，默认 100 tick；从首次 dirty 起算 |
| `priority` | 否 | 显式提供才参与固定 Segment 竞争；缺省或未入选使用主 Memory |

重复申请只有"声明完全一致"（版本、层、间隔、优先级以及 `initialize`/`migrate` 的函数引用）才复用同一句柄；任何差异都会抛配置错误。非法 `localId`、非正整数版本、非有限 priority 同样立即抛错。

## 就绪语义（pending 原因）

| reason | 含义 | 处理 |
| --- | --- | --- |
| `loading` | 首次加载尚未完成 | 下一 tick 重试 |
| `segment-activating` | 目标页尚未激活（请求后下一 tick 可见） | 下一 tick 重试 |
| `migration` | 分区正在搬迁，写入被冻结 | 等待迁移完成，继续无关工作 |
| `verification` | 搬迁副本等待回读校验 | 同上 |
| `recovery` | 数据损坏、归属不符或版本异常 | 由 `getStatus().fault/writeError` 暴露；页内容恢复一致后会在后续 tick 自动重读自愈，`writeError` 保留最近一次故障供回溯 |

`retryAt` 是建议重试 tick，不保证到期就绪。Framework 不会因为 pending 跳过插件的其它钩子、禁止其 Intent 或计入失败。

## 提交与失败

- `critical` 分区在每个 tick 收尾提交；`checkpoint` 分区从首次 dirty 起算，后续修改不延后期限。
- 主 Memory 只重新序列化变化的分区与目录；完全 clean 的 tick 不写 RawMemory；Segment 分区只写自己的页。
- 写入失败保留 dirty 与 `writeError`，下一 tick 重试；单个 Segment 分区失败不影响其它分区。
- 单页容量上限约 100 KB（当前按 JSON 字符数计量），超限拒绝写入并保留旧数据，不自动拆页。

## 分配与迁移

- 固定使用 10 个页（ID 0..9）并**排他占用**：激活请求提交精确集合，不并入外部活动页；外部工具不应与本模块同时使用这些页。
- `priority` 降序排名，只取前 10 个申请，同分按稳定身份排序；落选者与窗口后的新申请使用主 Memory。
- 启动窗口在首个 tick 收尾时封存。框架在安全模式、插件因 CPU 未准入或 setup 失败时会延后封存，最多 `maxStartupDeferrals`（默认 10）个 tick，超限强制封存并在诊断里标记。
- 页分配前必须先观察到页内容：只有"读到过且为空"的页参与分配；目录或迁移 journal 引用的页视为自有，其余非空页（其他工具数据、无归属的历史信封）登记为保留页并跳过，绝不覆盖。
- 搬迁串行执行：copy（暂存并写目标信封）→ 下一 tick 回读校验 → 切换目录 → cleanup（**确认新目录已随主 Memory 落盘后**才清空被腾退的页）；代际取自持久单调计数器，每次搬迁都是新值。中断后可跨 global reset 继续，且**不要求对应模块本轮重新申请**——数据从存储搬运，恢复以 journal 为准。
- 搬迁期间（copy/verify/switch）相关分区保持 `pending`，写入被冻结；插件的新提交会被拒绝，避免"提交未搬进目标、switch 又清掉 dirty"的静默丢失。cleanup 阶段目录已经切换，分区恢复可用。
- 被抢占的页会先腾退，再分配给本批入选者；旧页只有在目录落盘成功之后才被清空，任何时刻都至少保留一份有效数据。

## 诊断

```ts
const status = memory.getStatus();
// status.loaded / fault / tick
// status.startupWindowOpen / startupWindowForced / startupDeferrals
// status.allocations[]: owner、backend、segmentId、pending、dirty、writeError（最近一次故障，可能已恢复）
// status.migration: { generation, phase, reason, moves } | null
// status.reservedSegments[]: 被外部数据或未认领信封占用的页及原因
// status.unobservedSegments[]: 尚未观察到内容、暂不参与分配的页
// status.allocationSkipped[]: 分配规划中因数据未装载或损坏而落选的候选及原因
// status.preservedRootKeys: 未被本模块认领的 Memory 根字段
```

`fault` 非空表示存储无法解析（未知 schema、非法容器形状）：此时所有申请返回 `pending('recovery')`，管理器拒绝写入，原始数据保持不变。

## 数据安全边界

- 未知 schema、页归属不符、版本降级、缺少 `migrate` 的升级都会拒绝写入并给出诊断，不用空数据覆盖历史。
- 旧 `leviathan` 命名空间只做一次性导入（插件 payload 与版本号），不删除、不改写，可随时回退。
- 主 Memory 中其它工具的根字段原样保留，且不缓存其文本：写入时从宿主 `Memory` 现取现序列化，同一 global 内被替换或新增的根字段会被合并（深层原地修改不会被检测）。
- 运行中以 heap 数据为事实源：分区有未提交修改（dirty）时，重试装载绝不会用存储里的旧内容覆盖内存，页短暂不可见只会推迟提交。没有数据的分区不会参与 Segment 搬迁，并在 `allocationSkipped` 中给出原因。
- 不自动合并控制台等外部对存储的编辑，但会传播宿主的根字段变化（替换、新增、**删除**）；完全 clean 的 tick 不写 RawMemory。

## 日志

`createMemoryManager({ logging })` 接受注入的 `LoggerFactory`，作用域固定为 `MemoryManager`，接入规则见 [Core 架构 §10](../../design/core/README.md)。默认等级（warn/error 开、info/debug 关）下：

- 正常路径完全静默，包括迁移过程与 clean tick；
- `warn`：写入失败（同一原因一次）、页被外部数据占用、容量超限、启动窗口强制封存；
- `error`：存储加载失败、不可自愈的数据问题（schema、归属、版本）；
- 排查时用 `createLogging({ levels: { info: true } })` 打开迁移阶段与恢复日志，`debug` 级别另有 pending 往返追踪。

日志是补充信息，权威诊断仍以 `getStatus()` 为准。

## 性能注意

- 首次加载解析整份主 Memory 一次，稳态复用 heap 对象；每 tick 成本与变化分区数量相关，与总分区数无关。
- Segment 写入避免主 Memory 整串重组，但页的加载与切换有宿主成本；只为可重建缓存省 CPU 时优先使用闭包，不要为了占满 10 页而持久化。

## 应用层装配

`src/core/runtime` 是 Core 组合根，创建 Logger 后显式创建 MemoryManager，再把完整 Runtime 交给 Framework。`src/app/runtime.ts` 只创建 Runtime、选择插件并创建 Framework。业务模块只需通过 `context.memory` 申请分区，不需要也不允许自行创建存储入口。

**访问边界（AGENTS.md 第 9 节）**：`core/memoryManager` 是项目内唯一允许访问全局 `Memory`、`RawMemory` 与 Segment 的模块。其它模块若有跨 global 状态需求，必须走 `context.memory`；直接访问存储属于阻断问题，`test/memoryBoundary.test.ts` 会扫描 `src/` 自动拦截。

## 独立使用（不经 Framework）

`createRuntime({}, { memory })` 会把测试或特殊宿主提供的 MemoryHost 按模块名绑定到 `ModuleContext.memory`；独立 Runtime 不驱动 tick，调用方需要自行在边界调用 `memory.begin(tick)` / `memory.end(tick)`。模块级测试可以直接 `createMemoryManager({ logging, platform })` 注入日志工厂和假平台，不必启动框架。

## 迁移恢复注意事项

- global reset 后恢复 copy/verify/switch 时，重新申请仍返回 pending；业务版本升级回调延后到后端切换完成再执行，不能在冻结期间写入。
- 页不可见不会解除迁移冻结；只跳过依赖该分区的行为。
- 清理前检查管理范围、所有目录引用和信封 owner/代次/数据版本。旧 cleanup 记录缺少源代次时保留原页并输出诊断，不自动清空身份不明的数据。

## 未交付

- 同一 global 只应装配一个 MemoryManager：多个实例各自持有 heap 快照，会在同一命名空间上互相覆盖。
- 容量按字节的精确计量与目标运行时实测口径。
- 迁移期间的在线修改（当前冻结搬迁分区）与多迁移并行。
- 独立 heap 监控设施；旧布局导入仅覆盖插件 payload，Profiler 统计与健康表保留在原处不迁移。
